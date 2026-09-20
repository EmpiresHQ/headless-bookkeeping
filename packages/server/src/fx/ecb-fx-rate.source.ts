import { Injectable } from '@nestjs/common';
import {
  FxObservation,
  FxRateSource,
  FxRateUnavailableError,
} from './fx-rate.types';

/**
 * The ECB Data Portal SDMX REST endpoint. The series key is
 * `D.<QUOTE>.EUR.SP00.A` in the `EXR` dataflow:
 *   D    — daily frequency
 *   SP00 — spot
 *   A    — average/standardised measure (the published reference rate)
 *
 * Verified 2026-09-20 against
 * https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A
 */
const ECB_API_BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';

/** Wall-clock budget for one upstream call. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The only date shape SDMX uses for a daily series. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * EcbFxRateSource — the euro foreign exchange reference rates published by the
 * European Central Bank.
 *
 * Why the ECB, for an EE deployment
 * ---------------------------------
 * Estonian VAT law prescribes it. KMS § 29 lg 13 (Ministry of Finance
 * consolidated commentary, January 2026): "Kui muu tehingu puhul on käibemaksu
 * arvestamiseks vajalikud andmed väljendatud välisvaluutas, kohaldatakse
 * käesoleva seaduse § 11 kohaselt määratud päeval KEHTIVAT Euroopa Keskpanga
 * määratud euro vahetuskurssi." — for a non-import transaction the ECB euro
 * rate *in force* on the § 11 tax-point date applies. This implements EU VAT
 * Directive Art. 91 for Estonia (ADR-0004: the prescribed VAT-base rate is a
 * country-plugin rule, and this source is wired in by the EE plugin alone).
 *
 * Publication calendar (ecb.europa.eu, euro reference rates, verified
 * 2026-09-20): rates are "usually updated at around 16:00 CET every working
 * day, except on TARGET closing days", derived from the 14:10 CET concertation
 * procedure. So there is NO publication on weekends or TARGET holidays, and
 * none for the current day before ~16:00 CET. The statutory word is "kehtiv"
 * (in force), not "avaldatud sel päeval" (published that day): the last
 * published rate remains in force until the next publication. The
 * on-or-before fallback therefore lives in {@link FxRateService}, bounded and
 * explicit — and the date actually applied is persisted, so a fallback is
 * always visible after the fact rather than inferred.
 *
 * (KMS uses a different, forward-looking rule — "or, if no rates were published
 * for that day, the NEXT publication day's rate" — only where the statute pins a
 * fixed calendar date such as 1 January for the small-business threshold. That
 * is not a tax point and is out of scope here.)
 *
 * Quotation and precision: the ECB quotes units of the foreign currency per
 * ONE euro (1 EUR = 1.1193 USD), published to the series' own `DECIMALS`
 * (4 for USD/GBP, 2 for JPY). The published figure is stored verbatim; the
 * kernel never re-rounds it, and any inversion (USD → EUR) or cross rate is
 * derived explicitly by {@link FxRateService}.
 *
 * The ECB notes the rates are "published for information purposes only" and
 * discourages their use for transactions — which is precisely right here: this
 * is the prescribed VAT-BASE rate, not the bank's dealing rate. The bank's own
 * rate governs cash movement and realized FX (ADR-0004, Wave-5) and is read
 * from the statement, never from this source.
 */
@Injectable()
export class EcbFxRateSource implements FxRateSource {
  readonly sourceId = 'ECB';
  readonly baseCurrency = 'EUR';

  async fetchObservations(
    quoteCurrency: string,
    fromDate: string,
    toDate: string,
  ): Promise<FxObservation[]> {
    const url =
      `${ECB_API_BASE}/D.${encodeURIComponent(quoteCurrency)}.EUR.SP00.A` +
      `?startPeriod=${fromDate}&endPeriod=${toDate}&format=csvdata`;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'text/csv' },
      });
    } catch (err) {
      throw new FxRateUnavailableError(
        quoteCurrency,
        this.baseCurrency,
        toDate,
        `ECB request failed: ${err instanceof Error ? err.message : String(err)}`,
        'upstream_unavailable',
      );
    }

    // 404 is the ECB's answer for a series key it does not publish — i.e. a
    // currency it does not quote. That is "unsupported pair", not an outage,
    // but either way it is an explicit unavailability, never a fallback.
    // 404 is the ECB's answer for a series key it does not publish — verified
    // live: `D.XYZ.EUR.SP00.A` returns 404 "No Series was returned for the
    // query". That is an unsupported pair, which retrying will not fix. Any
    // other non-2xx is an outage, which retrying might.
    if (!response.ok) {
      throw new FxRateUnavailableError(
        quoteCurrency,
        this.baseCurrency,
        toDate,
        response.status === 404
          ? `ECB does not quote ${quoteCurrency}`
          : `ECB responded ${response.status}`,
        response.status === 404 ? 'unsupported_pair' : 'upstream_unavailable',
      );
    }

    const body = await response.text();
    return this.parseCsv(body, quoteCurrency, toDate);
  }

  /**
   * Parse the SDMX `csvdata` response — and REFUSE anything it cannot vouch
   * for, rather than reading it as "nothing published".
   *
   * The two outcomes look identical from the outside and mean opposite things.
   * A genuine non-publication window (verified live: the whole of
   * 2020-01-01, a TARGET closing day) answers HTTP 200 with an **entirely
   * empty body** — so emptiness is the authority's real "nothing here", and is
   * honoured. But a 200 carrying an error page, a truncated body or a garbled
   * row is not the authority saying nothing happened; it is us not knowing.
   * Treating the second as the first would let an older cached rate stand in
   * for a date that was never truly answered, and — because the probe window
   * would be recorded as covered — keep standing in after the authority
   * recovered. That is the date-blind behaviour this issue removes, arriving
   * through the back door.
   *
   * So: an empty body is `[]`; a header-only CSV is `[]`; anything else must
   * present a header naming TIME_PERIOD and OBS_VALUE, and every data row must
   * be trustworthy. One untrustworthy row condemns the whole response — a
   * partial read is not a safer read when the missing part may be the date we
   * were asked about.
   */
  private parseCsv(
    body: string,
    quoteCurrency: string,
    requestedTo: string,
  ): FxObservation[] {
    const unusable = (detail: string) =>
      new FxRateUnavailableError(
        quoteCurrency,
        this.baseCurrency,
        requestedTo,
        detail,
        'upstream_unavailable',
      );

    // The authority's own "nothing published in this window".
    if (body.trim() === '') {
      return [];
    }

    const rows = body.split('\n').filter((line) => line.trim() !== '');
    const header = rows[0].split(',').map((h) => h.trim());
    const dateIdx = header.indexOf('TIME_PERIOD');
    const valueIdx = header.indexOf('OBS_VALUE');
    const currencyIdx = header.indexOf('CURRENCY');
    if (dateIdx === -1 || valueIdx === -1) {
      throw unusable(
        'ECB response is not the expected CSV (no TIME_PERIOD/OBS_VALUE header)',
      );
    }

    // Header present but no data rows: a legitimate empty result set.
    if (rows.length === 1) {
      return [];
    }

    const observations: FxObservation[] = [];
    for (const row of rows.slice(1)) {
      const cells = this.splitCsvRow(row);
      const rateDate = cells[dateIdx]?.trim();
      const raw = cells[valueIdx]?.trim();

      if (rateDate === undefined || raw === undefined) {
        throw unusable(`ECB row is missing its date or value column: "${row}"`);
      }
      if (!ISO_DATE.test(rateDate)) {
        throw unusable(`ECB row carries an unreadable date "${rateDate}"`);
      }
      if (currencyIdx !== -1 && cells[currencyIdx]?.trim() !== quoteCurrency) {
        throw unusable(
          `ECB returned currency "${cells[currencyIdx]}" for a ${quoteCurrency} query`,
        );
      }

      // A published-but-empty observation is legitimate SDMX: OBS_STATUS flags
      // a day with no figure. It contributes nothing and is skipped — this is
      // the ONE thing that may be passed over, because the authority is
      // explicitly saying there is no value for that date.
      if (raw === '') {
        continue;
      }

      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw unusable(
          `ECB row for ${rateDate} carries an unusable value "${raw}"`,
        );
      }

      observations.push({
        baseCurrency: this.baseCurrency,
        quoteCurrency,
        rateDate,
        rate,
      });
    }

    return observations.sort((a, b) => a.rateDate.localeCompare(b.rateDate));
  }

  /** Minimal RFC4180 split — the TITLE_COMPL attribute is a quoted, comma-bearing string. */
  private splitCsvRow(row: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (quoted) {
        if (ch === '"') {
          if (row[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  }
}
