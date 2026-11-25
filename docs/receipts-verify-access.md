# Receipt verification with Cloudflare Access

The Worker accepts the dedicated Access service identity only for
`POST /receipts/verify`. It validates the signed Access JWT using the same
RS256 signature, expiry, and audience checks as human authentication. For the
dedicated machine identity, it compares the signed `common_name` claim to the
Worker binding `RECEIPT_VERIFIER_CLIENT_ID`. The comparison accepts a client
ID with or without the `.access` suffix.

The existing email-JWT and Worker shared-secret paths still apply to receipt
verification. The dedicated service identity has no email claim and does not
pass the existing email requirement for other protected routes.

## Preview-first rollout

1. Create an Access application scoped to `/receipts/verify` with a Service
   Auth policy that admits only the dedicated receipt-verifier service token.
   Keep the application's policy service-only because the Worker shares its
   audience allowlist with the existing identity verifier.
2. In the preview Worker's deployment configuration, set
   `RECEIPT_VERIFIER_CLIENT_ID` to `<dedicated-service-client-id>`. Append the
   new Access application's AUD to `ACCESS_AUD`, preserving the existing
   comma-separated values, for example
   `<existing-audience>,<receipt-application-audience>`.
3. Configure the automation's credential out of band. Verify that a valid
   token can POST to the receipt route and is denied for other protected routes.
4. Repeat the setup on production only after preview verification. Keep the
   binding and credentials out of the repository.

## Rollback

Unset `RECEIPT_VERIFIER_CLIENT_ID` in the relevant Worker environment. The
service-token path fails closed when the binding is missing or empty. The
existing email-JWT and Worker shared-secret paths remain available.
