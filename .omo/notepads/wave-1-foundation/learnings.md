# Wave 1 Foundation - Learnings

## Currency Module (Task 4)

### Created Files
- `src/currency/currency.service.ts` - CurrencyService with `getBaseCurrency()` and `convertToBase()`
- `src/currency/fx-rate.service.ts` - FXRateService with hardcoded exchange rates
- `src/currency/currency.module.ts` - Module definition with ORG_BASE_CURRENCY injection token
- `src/currency/currency.service.spec.ts` - Unit tests for both services

### Design Decisions
- **ORG_BASE_CURRENCY injection token**: Since OrganizationModule doesn't exist yet, CurrencyService receives base currency via a string injection token (`ORG_BASE_CURRENCY`). Default value is `'DKK'`. When OrganizationModule is built, this provider should be replaced with a factory that reads from the Organization entity.
- **FXRateService is a stub**: Hardcoded rates only (DKK↔USD, DKK↔EUR). TODO comment marks where external API integration (ECB, OpenExchangeRates) would go in production.
- **convertToBase signature**: Takes `(amount, currency, rate)` — the rate is passed in rather than looked up internally, keeping the service stateless and testable. Callers use FXRateService.getRate() to obtain the rate, then pass it to convertToBase().

### Hardcoded FX Rates
| From | To | Rate |
|------|-----|------|
| DKK | USD | 0.14 |
| USD | DKK | 7.14 |
| DKK | EUR | 0.134 |
| EUR | DKK | 7.46 |

### Modified Files
- `src/app.module.ts` - Added CurrencyModule to imports array

## CountryPlugin Infrastructure (Task 3)

### Created Files
- `src/plugins/country-plugin.interface.ts` - CountryPlugin interface + VATCode type + CategoryMappingResult interface
- `src/plugins/null-country.plugin.ts` - NullCountryPlugin stub implementing CountryPlugin with safe defaults
- `src/plugins/plugin-loader.service.ts` - PluginLoader service with map-based plugin resolution
- `src/plugins/plugin-loader.service.spec.ts` - 11 unit tests covering NullCountryPlugin and PluginLoader

### Design Decisions
- **VATCode as string alias**: `VATCode` is a type alias for `string` (not an interface), keeping it lightweight. Country plugins define their own VAT code vocabulary (e.g. `"DK_INPUT_25"`).
- **CategoryMappingResult interface**: Separate interface with `account: string` and `vatCode: VATCode` — bridges user-facing Category to kernel Account + VAT code.
- **NullCountryPlugin safe defaults**: Returns `"null"` name, `["NULL_STANDARD"]` VAT codes, `"yearly"` frequency. Maps `"software"` → `{ account: "EXPENSE_SOFTWARE", vatCode: "NULL_STANDARD" }`. Unknown categories get generic `EXPENSE_${CATEGORY}` accounts.
- **PluginLoader map-based resolution**: Simple `Map<string, CountryPlugin>` — currently only registers the null plugin. Any unrecognized country code falls back to NullCountryPlugin. No dynamic loading from npm/packages.
- **supplierContext typed as `unknown`**: Interface uses `unknown` for context parameters (not `any`), enforcing type safety at call sites.

### Modified Files
- `src/app.module.ts` - Registered NullCountryPlugin and PluginLoader as providers

### Test Results
- 11 tests passed: 7 for NullCountryPlugin, 4 for PluginLoader
- Covers: getName, getVATCodes, resolveCategoryMapping (software + generic), period frequencies, VAT validation, resolve for known/unknown country codes

## Kysely Migration Runner (Task 1)

### Created Files
- `src/database/migrations/001_create_organization.ts` - First migration: creates `organization` table + seeds default org (DK/DKK)
- `src/database/migrations/index.ts` - Exports migrations array with `{ name, migration }` format
- `src/database/database.module.spec.ts` - Tests proving migrations run, table exists, and seed data is correct

### Modified Files
- `src/database/database.module.ts` - Added `MigrationRunner` provider with `OnModuleInit` that runs `Migrator.migrateToLatest()`
- `src/database/types.ts` - Replaced `users` table with `organization` table in Database interface
- `src/app.service.ts` - Removed all ad-hoc `CREATE TABLE` code (OnModuleInit deleted entirely), updated queries to use `organization` table

### Design Decisions
- **Inline MigrationProvider**: Instead of `FileMigrationProvider` (which requires compiled JS paths), used an inline provider with `getMigrations: () => Promise.resolve(migrations)` — simpler for NestJS where migrations are imported as modules.
- **MigrationRunner as internal provider**: The `MigrationRunner` class is a private provider inside DatabaseModule (not exported). It runs migrations on module init via `OnModuleInit`.
- **vat_registered as integer**: SQLite has no native BOOLEAN, so stored as `integer` (0/1). The Kysely type uses `number | null`.
- **Organization table has no `users` table**: The old `users` table was completely removed from the Database interface. AppService methods now query `organization` instead.
- **Kysely `Generated<number>`**: Used for the `id` column to mark it as auto-generated (makes it optional in inserts).

## Organization Singleton Module (Task 2)

### Created Files
- `src/organization/types.ts` - Organization interface + UpdateOrganizationDto
- `src/organization/organization.service.ts` - Service with getOrganization() and updateOrganization(), singleton enforcement
- `src/organization/organization.controller.ts` - Controller with GET/PUT /api/organization endpoints
- `src/organization/organization.module.ts` - Module importing DatabaseModule
- `src/organization/organization.controller.spec.ts` - 5 unit tests (GET default, GET not found, PUT full update, PUT partial update, singleton constraint)

### Modified Files
- `src/database/types.ts` - Added OrganizationTable to Database interface (id: Generated<number>, country, base_currency, vat_registered: number, created_at)
- `src/app.module.ts` - Registered OrganizationModule in imports array

### Design Decisions
- **Singleton enforcement in service layer**: `updateOrganization()` checks row count === 1 before allowing updates, throws ConflictException if violated. `onModuleInit()` seeds exactly one row if none exists.
- **vat_registered stored as integer (0/1)**: SQLite has no native boolean. Service maps 0→false, 1→true on read; true→1, false→0 on write.
- **UpdateOrganizationDto uses optional fields**: Only country, base_currency, vat_registered are mutable. id and created_at are immutable. Partial updates supported.
- **Table creation in service OnModuleInit**: OrganizationService creates the table and seeds the singleton on module init, following the same pattern as AppService's users table.
- **import type for DTO**: UpdateOrganizationDto imported with `import type` to satisfy isolatedModules + emitDecoratorMetadata requirement.
- **mapRow uses explicit row type**: Instead of Database['organization'] (which has Generated<number> for id), mapRow accepts a concrete type with id: number since Kysely's select returns resolved Generated types.

### Test Results
- 5 tests passed: GET returns defaults (DK/DKK/false), GET throws NotFoundException, PUT full update, PUT partial update, singleton constraint throws ConflictException
