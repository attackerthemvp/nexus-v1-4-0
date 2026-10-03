// NEXUS replacement for upstream Python imaging (PIL) in the pixel safety net:
// draws the red target dot on a screenshot with a browser canvas.
export async function markTarget(b64: string, mime: string, norm: [number, number]): Promise<string | null> {
  if (typeof document === "undefined") return null;
  try {
    const img = new Image();
    img.src = `data:${mime};base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    const x = (norm[0] / 1000) * c.width;
    const y = (norm[1] / 1000) * c.height;
    const r = Math.max(8, Math.round(c.width / 60));
    g.fillStyle = "rgb(255,0,0)";
    g.strokeStyle = "rgb(255,255,255)";
    g.lineWidth = Math.max(2, r / 4);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    return c.toDataURL("image/png").split(",")[1] ?? null;
  } catch {
    return null;
  }
}
