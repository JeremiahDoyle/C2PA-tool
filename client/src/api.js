const API_BASE = '' // Vite dev proxies /api to server

export async function signImage({ name, dataUrl }) {
  const res = await fetch(`${API_BASE}/api/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageName: name, imageData: dataUrl })
  })
  return res.json()
}

export async function verifyImage({ name, dataUrl }) {
  const res = await fetch(`${API_BASE}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageName: name, imageData: dataUrl })
  })
  return res.json()
}

