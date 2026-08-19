import subprocess
import json

with open("/home/ubuntu/clfchub/worker/src/index.js") as f:
    code_str = f.read()

metadata = {
    "main_module": "index.js",
    "compatibility_date": "2026-08-19",
    "bindings": [
        {
            "type": "d1",
            "name": "DB",
            "database_id": "199c7c5a-b202-4439-9401-4c2f27e33ea5"
        }
    ],
    "vars": {
        "PLAYHQ_ORG_ID": "89b6bccc-ad76-4766-8b96-9f1fc00738ec",
        "PLAYHQ_API_KEY": "1334794e-2013-4983-994c-92cc95d25e86",
        "ADMIN_PASSCODE": "94172079"
    },
    "triggers": {
        "crons": [
            "0 12 * * 5",
            "0 0 * * 6"
        ]
    }
}

exec_script = """async () => {
  const code = %s;
  const metadata = %s;
  const b = "----Boundary123456";
  const body = [
    `--${b}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(metadata),
    `--${b}`,
    'Content-Disposition: form-data; name="index.js"; filename="index.js"',
    "Content-Type: application/javascript+module",
    "",
    code,
    `--${b}--`,
    ""
  ].join("\\r\\n");

  return cloudflare.request({
    method: "PUT",
    path: `/accounts/${accountId}/workers/scripts/clfchub`,
    body,
    contentType: `multipart/form-data; boundary=${b}`,
    rawBody: true
  });
}""" % (json.dumps(code_str), json.dumps(metadata))

input_data = {"code": exec_script}
with open("/tmp/deploy_input.json", "w") as f:
    json.dump(input_data, f)

res = subprocess.run([
    "manus-mcp-cli", "tool", "call", "execute",
    "--server", "cloudflare",
    "--input-file", "/tmp/deploy_input.json"
], capture_output=True, text=True)

print(res.stdout)
print(res.stderr)
