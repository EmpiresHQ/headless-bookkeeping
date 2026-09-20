import { Injectable, Logger } from '@nestjs/common';
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

  private readonly logger = new Logger(EcbFxRateSource.name);

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
      );
    }

    // 404 is the ECB's answer for a series key it does not publish — i.e. a
    // currency it does not quote. That is "unsupported pair", not an outage,
    // but either way it is an explicit unavailability, never a fallback.
    if (!response.ok) {
      throw new FxRateUnavailableError(
        quoteCurrency,
        this.baseCurrency,
        toDate,
        response.status === 404
          ? `ECB does not quote ${quoteCurrency}`
          : `ECB responded ${response.status}`,
      );
    }

    const body = await response.text();
    return this.parseCsv(body, quoteCurrency, toDate);
  }

  /**
   * Parse the SDMX `csvdata` response. Columns are addressed BY NAME from the
   * header row (the dataflow carries ~30 attribute columns whose order is not
   * contractual), so an upstream column reshuffle cannot silently shift which
   * field we read as the rate.
   */
  private parseCsv(
    body: string,
    quoteCurrency: string,
    requestedTo: string,
  ): FxObservation[] {
    const rows = body.split('\n').filter((line) => line.trim() !== '');
    // An empty result set (no publication in the window) is a legitimate
    // answer: header only, or a body with no rows at all.
    if (rows.length <= 1) {
      return [];
    }

    const header = rows[0].split(',').map((h) => h.trim());
    const dateIdx = header.indexOf('TIME_PERIOD');
    const valueIdx = header.indexOf('OBS_VALUE');
    const currencyIdx = header.indexOf('CURRENCY');
    if (dateIdx === -1 || valueIdx === -1) {
      throw new FxRateUnavailableError(
        quoteCurrency,
        this.baseCurrency,
        requestedTo,
        'ECB response is missing TIME_PERIOD/OBS_VALUE columns',
      );
    }

    const observations: FxObservation[] = [];
    for (const row of rows.slice(1)) {
      const cells = this.splitCsvRow(row);
      const rateDate = cells[dateIdx]?.trim();
      const raw = cells[valueIdx]?.trim();
      const rate = Number(raw);

      // A published-but-empty observation happens in SDMX (OBS_STATUS flags a
      // non-published day). Skip it rather than coercing '' to 0 — a zero rate
      // would be an unsupported base amount, and CHECK(rate > 0) exists to
      // make sure one never reaches the cache.
      if (!rateDate || raw === '' || !Number.isFinite(rate) || rate <= 0) {
        continue;
      }
      if (currencyIdx !== -1 && cells[currencyIdx]?.trim() !== quoteCurrency) {
        this.logger.warn(
          `ECB returned currency ${cells[currencyIdx]} for a ${quoteCurrency} query; row ignored`,
        );
        continue;
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
