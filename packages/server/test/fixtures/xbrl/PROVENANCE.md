# Vendored Estonian annual-report XBRL taxonomy (et-gaap)

## Why this file is here

Issue #204 requires the annual-accounts XBRL export to be validated against the
*actual supported taxonomy*, not merely against XML syntax. That is only
possible with the authoritative concept declarations in hand, so the taxonomy's
core schema is vendored here byte-exact and the test suite validates generated
instances against it offline and deterministically.

## Authoritative source

The annual-report taxonomy is established by regulation and published by the
Centre of Registers and Information Systems (Registrite ja Infosüsteemide
Keskus, RIK) at <https://xbrl.eesti.ee/>, which is the address named by the
regulation and linked from
<https://www.rik.ee/et/e-ariregister/majandusaasta-aruanne> and
<https://abiinfo.rik.ee/en/filing-annual-reports>.

Regulation establishing the taxonomy (2026 entry on xbrl.eesti.ee):
<https://www.riigiteataja.ee/akt/105092025011>

## Files

| Vendored path | Retrieved from | SHA-256 |
| --- | --- | --- |
| `et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd` | `http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd` | `8810b65881d7d788de5b33c70ad71c2fb66638991d98a598f48eff3fd3e0f32f` |

Retrieved 2026-09-20. `et-gaap-cor_2026-01-01.xsd` is the element-declaration
("core") schema of taxonomy version `et-gaap_2026-01-01`; it is the schema an
instance's `link:schemaRef` points at, and it is the only part of the taxonomy
RIK serves at a resolvable canonical URL. The presentation / calculation /
definition / label linkbases ship separately in
`http://xbrl.eesti.ee/wp-content/uploads/2026/02/et-gaap_2026-01-01.zip`
(SHA-256 `52a715e2d41fa1a701d961b89aab52512e90c56f4b57cfe170e759d737956aaa`,
retrieved 2026-09-20) and are **not** vendored: their internal `xlink:href`s are
relative to a deployment layout RIK does not publish, and nothing in the Jest
suite needs them. They are used out-of-band by the Arelle runner — see
`../../xbrl/README.md`.

## Licence

> Copyright (C) 2026 Centre of Registers and Information Systems
>
> Licensed under the EUPL, Version 1.1

(quoted from the header comment of the vendored schema; see
<http://ec.europa.eu/idabc/eupl.html>). The file is redistributed unmodified.

## Re-fetch / verify

```sh
curl -sSLo /tmp/et-gaap-cor_2026-01-01.xsd \
  http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd
sha256sum /tmp/et-gaap-cor_2026-01-01.xsd
diff /tmp/et-gaap-cor_2026-01-01.xsd \
  packages/server/test/fixtures/xbrl/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd
```
