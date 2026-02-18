const raw = process.env.VITE_SUPABASE_EMAIL_REDIRECT_TO?.trim();

if (!raw) {
  console.error(
    "Missing VITE_SUPABASE_EMAIL_REDIRECT_TO. Set it to your public HTTPS app URL (for example, https://example.com/)."
  );
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(raw);
} catch {
  console.error(
    `Invalid VITE_SUPABASE_EMAIL_REDIRECT_TO value: "${raw}". Expected a full HTTPS URL.`
  );
  process.exit(1);
}

if (parsed.protocol !== "https:") {
  console.error(
    `VITE_SUPABASE_EMAIL_REDIRECT_TO must use https:// for Android App Links. Received: "${raw}".`
  );
  process.exit(1);
}

if (!parsed.hostname) {
  console.error(
    `VITE_SUPABASE_EMAIL_REDIRECT_TO is missing hostname: "${raw}".`
  );
  process.exit(1);
}

process.stdout.write(parsed.hostname);
