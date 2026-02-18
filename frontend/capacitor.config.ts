import type { CapacitorConfig } from "@capacitor/cli";

const insecureMobileMode = process.env.MOBILE_INSECURE === "true";

const config: CapacitorConfig = {
  appId: "io.jph",
  appName: "Anycard",
  webDir: "dist",
  server: {
    androidScheme: insecureMobileMode ? "http" : "https",
  },
};

export default config;
