## C2PA Demo: Sign & Verify (PoC)

This repo includes a minimal Node server and a simple React UI to sign and verify images using `c2patool` inside Docker. It uses the existing `Dockerfile`, `manifest.json`, and trust bundle in this folder.

Important: Do not commit private keys. A sample manifest is provided as `manifest.sample.json`; copy it to `manifest.json` and place your own key/cert locally.

### Prerequisites

- Docker Desktop running
- Node.js 18+

### One‑liner run

```
bash run.sh
```

By default it uses port `8090`. To use a specific port:

```
PORT=3007 bash run.sh
# or
bash run.sh 3007
```

This builds the Docker image if needed, builds the React client, starts the server, and opens `http://localhost:<PORT>`.

Server exposes:
- `POST /api/sign` → body: `{ imageName, imageData }` where `imageData` is a data URL or base64 string; returns `{ ok, fileName, dataUrl }`.
- `POST /api/verify` → body: `{ imageName, imageData }`; returns `{ ok, output, error }`.

### Run the server (manual)

```
PORT=8090 node server.js
```

On first sign/verify, it builds the `c2pa-demo` Docker image defined in `Dockerfile` and uses `C2PA-TRUST-BUNDLE.pem` and `manifest.json` to sign and validate.

Setup before running:
- Copy `manifest.sample.json` to `manifest.json` and adjust paths as needed.
- Place your test private key and signing cert alongside `manifest.json` (default names: `mykey.key`, `mycert.pem`).
- Ensure `C2PA-TRUST-BUNDLE.pem` contains the issuing CA chain for your signing cert.

### Dev mode client (optional)

In `client/` for hot-reload dev:

```
npm install
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api/*` to `http://localhost:8080` by default; adjust `client/vite.config.js` if you run the server on another port.

### Package for others (single Docker image)

Build a self-contained image that includes c2patool, the server, and the built UI:

```
docker build -f Dockerfile.web -t c2pa-web .
docker run --rm -p 8090:8080 \
  -v "$(pwd)/mykey.key:/app/mykey.key:ro" \
  -v "$(pwd)/mycert.pem:/app/mycert.pem:ro" \
  -v "$(pwd)/C2PA-TRUST-BUNDLE.pem:/app/C2PA-TRUST-BUNDLE.pem:ro" \
  c2pa-web
```

Then open `http://localhost:8090`. This image runs `c2patool` inside the container (no Docker-in-Docker required), and serves the UI from the same port. Keys/certs are mounted at runtime; they are not baked into the image.

You can publish the image to a registry (e.g., Docker Hub or GHCR) to share with others, and they only need Docker to run it.

Security note: Do not ship private keys in images or commits. For production, use a signing service, KMS/HSM, or inject keys at runtime via secrets/volumes.

### Alternative distribution

- Share the repo as-is; users run `bash run.sh` (requires Docker + Node).
- Or build the client and serve statically behind any host, while running `server.js` on a Node host with Docker available.

### Configuration

- `PORT`: server port (default 8090 when using `run.sh`; 8080 inside the all-in-one Docker image).
- `C2PA_MODE`: set to `local` to force using a locally available `c2patool` binary (used by the all-in-one image). Defaults to Docker mode if not set and `c2patool` not found.
- `C2PA_DOCKER_IMAGE`: override the Docker image name used when in Docker mode (defaults to `c2pa-demo`).
- `MANIFEST_PATH`: path to `manifest.json` (default: `manifest.json`).
- `TRUST_BUNDLE_PATH`: path to trust bundle PEM (default: `C2PA-TRUST-BUNDLE.pem`).


### Build client for production

```
cd client
npm run build
```

The static files are in `client/dist`. Serve them with any static server and ensure the API server is reachable at `http://localhost:8080` or adjust the proxy/base.

### Notes

- The signing command mirrors `c2pa_sign_tamper_verify.sh`.
- Output files are written to repo root by Docker; the API returns a data URL for immediate download.
- Verification returns a PASS/FAIL plus the first lines of tool output.

### Using real certificates

- Replace the test key/cert with your real signing materials. Keep private keys out of Git.
- Update `manifest.json` to point to the correct file paths. If running the all‑in‑one image, mount files into `/app` as shown above.
- Set a production timestamping URL if needed (`ta_url`).
