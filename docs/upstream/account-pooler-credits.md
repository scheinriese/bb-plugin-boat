# bb Account Pooler: credits status

Boat can only see Claude extra usage as allowed or rejected, as reported by
bb's built-in Account Pooler. Two upstream issues track what would make this
clearer:

- [get-bb/bb#7739](https://github.com/get-bb/bb/issues/7739): Provider usage
  keeps showing old readings after the Account Pooler is disabled, and failed
  usage refreshes are silent.
- [get-bb/bb#7740](https://github.com/get-bb/bb/issues/7740): show Claude
  credits (monthly limit and amount spent) in Provider usage.

Until then Boat shows the Pooler's verdict and when it was taken, e.g.
"Claude extra usage: blocked · last checked 14:02 by the Account Pooler",
"available", or "unknown (Account Pooler off)". Boat never sees a balance.
