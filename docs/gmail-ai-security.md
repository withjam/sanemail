# Gmail AI Security And Model Provider Policy

## Decision

For production Gmail users, SaneMail should not send Gmail-derived content to an
arbitrary hosted model provider by default.

The safe default is:

- keep `AI_PROVIDER=mock` or a local/self-hosted model for development and
  deterministic verification
- use Ollama Cloud only for explicit local/dev/beta opt-in
- prefer Vertex AI or self-hosted inference for production Gmail launches
- treat Gmail restricted-scope verification and security assessment as a launch
  workstream, not cleanup

## Why

The Gmail API scope we currently target, `gmail.readonly`, is a restricted
Google Workspace scope. If SaneMail stores, transmits, or processes Gmail data
server-side for a public app, Google can require restricted-scope verification
and a security assessment.

Generative AI summaries and productivity features are compatible with Google's
policy direction, but the data use has to stay inside the user-facing product
purpose. Gmail-derived data must not be used for ads, resale, data brokerage, or
general model training.

## Requirements For Gmail-Derived Data

Before a public Gmail launch, SaneMail should be ready to show:

- clear user consent before connecting Gmail
- precise scope justification for `gmail.readonly`
- privacy policy and terms that describe AI processing
- data deletion and disconnect flows
- encrypted OAuth tokens at rest
- encrypted Gmail-derived data at rest and in transit
- least-privilege internal access
- no generalized model training on Gmail data
- no ad targeting or sale/transfer of Gmail data
- redacted observability traces by default
- auditability for model/provider decisions
- documented subprocessors/model providers

## Provider Options

### 1. Custom Domains / MX First

This avoids the Gmail restricted-scope process initially because users route mail
to SaneMail directly. It is cleaner for infrastructure control, but it asks users
to change email hosting before they have experienced product value.

Use when:

- we want the fastest compliance path
- we can tolerate a smaller initial audience
- we want full control over mail storage and processing

### 2. Gmail + Local Or Self-Hosted Model

This is the strongest privacy story. Gmail content stays in our controlled
runtime, and the model provider boundary is SaneMail's own infrastructure.

Use when:

- we need maximum trust for Gmail verification
- latency/cost is manageable
- we are ready to operate inference infrastructure

### 3. Gmail + Vertex AI

Vertex AI is the preferred hosted production candidate because it is inside the
Google Cloud security/compliance ecosystem and supports enterprise controls such
as IAM, VPC Service Controls, CMEK where supported, data residency options, and
documented data governance.

This does not eliminate Gmail restricted-scope verification, but it gives us a
much stronger story for data handling and assessor review.

Use when:

- we need hosted model quality and reliability
- we want a provider with mature enterprise controls
- we are already using Google Cloud for Gmail/Pub/Sub infrastructure

### 4. Gmail + Ollama Cloud

Ollama Cloud is useful for development, demos, and explicit beta opt-in. It is
not our default production Gmail provider today because Gmail content would leave
our infrastructure and we have fewer enterprise controls to point to than with
Vertex AI or self-hosted inference.

Use when:

- the user is a founder/dev/test user
- the user explicitly opts into remote model processing
- the mailbox data is synthetic or low risk
- we are measuring model quality, not launching broad public Gmail support

### 5. Hybrid Minimization

Run cheap local/security heuristics first, then send only the minimum necessary
text to a cloud model for cases that need it.

Examples:

- send a snippet instead of full body when classification is enough
- send one thread window instead of full history
- redact obvious secrets before remote calls
- avoid attachments until explicitly needed
- keep embeddings or summaries local where feasible

This should be our default architecture even when using Vertex AI.

## Current MVP Policy

Current code should keep these defaults:

```text
AI_PROVIDER=mock
AI_FALLBACK_TO_MOCK=true
PHOENIX_ALLOW_SENSITIVE_CONTENT=false
OPENINFERENCE_HIDE_INPUTS=true
OPENINFERENCE_HIDE_INPUT_MESSAGES=true
OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS=true
```

Ollama Cloud may be used deliberately:

```sh
AI_PROVIDER=ollama OLLAMA_MODEL=deepseek-v4-pro:cloud OLLAMA_THINK=high bun run dev
```

That command is a conscious dev/runtime choice. It should not become the default
for live Gmail data without a product consent flow and security review.

## Recommended Launch Path

1. Keep synthetic/demo data and mock provider as the default.
2. Use Ollama Cloud for local model-quality iteration with explicit env flags.
3. Add a provider capability matrix and consent copy before live Gmail beta.
4. For public Gmail, choose Vertex AI or self-hosted inference as the default.
5. Complete Google restricted-scope verification and security assessment before
   broad Gmail launch.

## References

- Google Workspace API user data policy:
  https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Gmail API scopes:
  https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth restricted-scope verification:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Vertex AI data governance:
  https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance
- Vertex AI zero data retention:
  https://cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention
- Vertex AI security controls:
  https://cloud.google.com/vertex-ai/generative-ai/docs/security-controls
- Ollama privacy policy:
  https://ollama.com/privacy
