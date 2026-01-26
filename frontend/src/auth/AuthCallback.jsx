import { useEffect, useState } from "react";
import { handleAuthCallback } from "./auth";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Signing you in...");

  useEffect(() => {
    (async () => {
      try {
        await handleAuthCallback();
        setMsg("Signed in. Redirecting...");

        // ✅ Always redirect to SPA base ("/app/" in prod, "/" in dev)
        const base = import.meta.env.BASE_URL || "/";
        window.location.assign(base);
      } catch (e) {
        setMsg(e?.message || "Login failed");
      }
    })();
  }, []);

  return (
    <div style={{ padding: 16, color: "#CBD5F5" }}>
      <div style={{ fontSize: 18, fontWeight: 900, color: "#F9FAFB" }}>
        {msg}
      </div>
    </div>
  );
}
