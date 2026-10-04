# Headless Accounting OS

Vocabulary for the operator's bookkeeping work. Existing accounting terms are defined in [CONTEXT.md](CONTEXT.md#language).

## Language

**Operation result**:
A record of what was confirmed, or remained unconfirmed, when the operator attempted a bookkeeping action, such as submitting an Expense for posting or creating and matching an Expense from a bank line. It describes that attempt; a recorded wait for Approval remains historically valid after the object is approved.
_Avoid_: Current object state, proof of the object's present status

**Current object state**:
The business object's state at the time it is checked, including changes that happened after an earlier operation result was recorded.
_Avoid_: Operation result, receipt (when referring to present status)
