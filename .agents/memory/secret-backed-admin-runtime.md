---
name: Secret-backed admin runtime
description: Environment-specific behavior discovered while debugging admin authentication and workflow secrets.
---

The presence flag for a Replit secret does not guarantee that a running workflow has a non-empty value. Admin authentication must treat a missing or empty `ADMIN_PASSWORD` as unavailable, and the API workflow must be restarted after changing the secret.

**Why:** The admin secret was stored but reached the API process empty, causing every admin login and therefore every user-creation attempt to fail with a configuration error.

**How to apply:** When debugging secret-backed routes, inspect only presence/length metadata through the secrets tooling, never print the value, then restart the owning workflow before testing the route.