# Single-tenant, mono-structure deployment

One deployment serves exactly one Organization, in exactly one country, with one active country plugin and one reporting currency. There is no `org_id` or own-entity scoping in the schema — the Organization is implicit. Counterparties are modelled as Entities (`role: supplier | customer`); the only multiplicity is counterparties, not own-businesses.

Anyone needing multiple businesses, countries, or tenants runs a second container with its own SQLite file. We chose this over multi-entity or multi-tenant schemas because the target user is a single freelancer / micro-SMB, and the local-first, single-SQLite, $5-VPS deployment model makes "spin up another instance" cheaper than carrying tenant-scoping complexity through every table, query, and the country resolver. The accepted cost: retrofitting multi-entity later would be a painful migration.
