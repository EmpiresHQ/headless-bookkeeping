# Double-entry ledger, hidden behind semantic categories

The kernel keeps a real double-entry ledger (Vouchers of balanced debit/credit VoucherLines against a chart of Accounts) so it can serve as the legally-valid system of record — producing trial balances and VAT reports an accountant will accept. But SMB users never see accounts or debits/credits; they interact only with semantic Categories (`software`, `transport`, …), which a country plugin maps to Account + VAT code at posting time.

We chose this over a single-entry categorized journal because single-entry cannot be a true source of truth — it can't produce a balance and would force a hand-off to an external accounting system. Debits/credits are deliberately hidden because they carry no meaning for the target user (freelancers / micro-SMBs).
