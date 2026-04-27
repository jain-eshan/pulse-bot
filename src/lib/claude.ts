export type ParsedSession = {
  title: string;
  description: string;
  starts_at: string;
  venue: string;
  tags: string[];
};

export async function parseSession(text: string): Promise<ParsedSession | null> {
  if (!process.env.ANTHROPIC_PARSE_URL || !process.env.ANTHROPIC_PARSE_KEY) {
    return null;
  }
  try {
    const r = await fetch(process.env.ANTHROPIC_PARSE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ANTHROPIC_PARSE_KEY}`,
      },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j?.title || !j?.starts_at) return null;
    return j as ParsedSession;
  } catch {
    return null;
  }
}
