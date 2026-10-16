# Verifying third-party clients

These checks run real WooCommerce clients against a local emulator. They complement the automated suite (`npm test`), which already includes WooCommerce's official JavaScript client. Results from October 2026 are in the [README](../README.md#integration-compatibility).

Start the local server with sample data first. It has 250 orders, a small catalog, an in-memory webhook store, and the credentials `ck_fixture` / `cs_fixture`:

```bash
npm ci && npm run build
node scripts/dev-server.mjs 8787 250
```

It logs every request to stderr through the `onRequest` observer. The log shows which endpoints and parameters a client uses.

## n8n

Tested with n8n 2.35.7, installed outside this repository with `npm install n8n`. Set `N8N_USER_FOLDER` to a scratch directory, and set `N8N_RUNNERS_ENABLED=false` for CLI execution.

1. Import a `wooCommerceApi` credential with `url` set to `http://127.0.0.1:8787`, using `n8n import:credentials --input=creds.json`. Repeat with `includeCredentialsInQuery` set to `true` and to `false`.
2. Import a workflow with `n8n import:workflow`. It chains Manual Trigger, WooCommerce (order, Get Many, Return All), Limit (1), WooCommerce (order, Get, `{{ $json.id }}`), and WooCommerce (order, Update, status `completed`).
3. Run it with `n8n execute --id=<workflow id> --rawOutput`. Expect every processing order from Get Many, then one order from Get and one from Update.

Trigger test:

1. Import a workflow with a WooCommerce Trigger node (event `order.updated`) and publish it with `n8n publish:workflow --id=<id>`.
2. Start n8n with these environment variables: `N8N_LISTEN_ADDRESS=127.0.0.1 N8N_PORT=5678 WEBHOOK_URL=http://127.0.0.1:5678/ n8n start`. The server log should show `GET /wc/v3/webhooks?status=active&per_page=100`, followed by `POST /wc/v3/webhooks`.
3. Request `http://127.0.0.1:8787/__dispatch`. The delivery should report HTTP 200, and n8n should record a successful `webhook` execution.

## Singer `tap-woocommerce`

Tested with singer-io `tap-woocommerce` 0.1.2 in a virtual environment:

```bash
python3 -m venv venv
venv/bin/pip install "git+https://github.com/singer-io/tap-woocommerce"
venv/bin/pip install -U requests urllib3   # the pinned requests fails on Python 3.13
```

Configure `{"url": "http://127.0.0.1:8787/", "consumer_key": "ck_fixture", "consumer_secret": "cs_fixture", "start_date": "2026-01-01T00:00:00Z"}`. The trailing slash in `url` is required.

Run `--discover`, set `"selected": true` on the orders stream schema, and then sync with `--catalog`. Expect one `RECORD` per order across `wc/v2/orders` pages, followed by a `STATE` bookmark.

## Airbyte `source-woocommerce`

Tested with manifest 5.11.1 from `airbytehq/airbyte` (`airbyte-integrations/connectors/source-woocommerce/manifest.yaml`), run by `airbyte-cdk`'s `source-declarative-manifest` entry point.

The connector requires HTTPS, so start the dev server with a throwaway certificate and point Python at that certificate. Certificate verification stays enabled:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout key.pem -out cert.pem
TLS_KEY_FILE=key.pem TLS_CERT_FILE=cert.pem node scripts/dev-server.mjs 8443 250

python3 -m venv venv && venv/bin/pip install airbyte-cdk
# config.json: {"__injected_declarative_manifest": <manifest.yaml as JSON>, "shop": "localhost:8443",
#               "api_key": "ck_fixture", "api_secret": "cs_fixture", "start_date": "2025-12-01"}
REQUESTS_CA_BUNDLE=cert.pem venv/bin/source-declarative-manifest check --config config.json
REQUESTS_CA_BUNDLE=cert.pem venv/bin/source-declarative-manifest read --config config.json --catalog catalog.json
```

Use a configured catalog that selects the `orders` stream with `sync_mode: incremental` and `cursor_field: ["date_modified_gmt"]`. The check calls `/system_status/tools`. The read should emit one record per order across `modified_after`/`modified_before` windows and `offset` pages. Rerunning with `--state` and the last state message should emit no records.

## Hosted services

Hosted services need a public HTTPS deployment of your own store. For each one, record:
- the service and the date tested;
- the connection method;
- the endpoints observed in the `onRequest` log;
- the import and update scenarios that succeeded.

For one-click connections, add the callback and return URLs the service uses to `oauth.allowedCallbackUrls` and `oauth.allowedReturnUrls`.
