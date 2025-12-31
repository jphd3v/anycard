export function isTestMode(): boolean {
  try {
    const qs = new URLSearchParams(window.location.search);
    return (
      qs.get("test") === "true" || import.meta.env.VITE_TEST_MODE === "true"
    );
  } catch {
    return import.meta.env.VITE_TEST_MODE === "true";
  }
}

export type TestContextLabel = "A" | "B" | "C" | "D";

export function getTestContextLabel(): TestContextLabel | null {
  try {
    const raw = new URLSearchParams(window.location.search).get("ctx");
    if (!raw) return null;
    const value = raw.trim().toUpperCase();
    if (value === "A" || value === "B" || value === "C" || value === "D") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
