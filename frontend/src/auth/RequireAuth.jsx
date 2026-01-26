import { useEffect } from "react";
import { isLoggedIn, login } from "./auth";

export default function RequireAuth({ children }) {
  useEffect(() => {
    if (!isLoggedIn()) login();
  }, []);

  if (!isLoggedIn()) {
    return (
      <div style={{ padding: 16, color: "#CBD5F5" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#F9FAFB" }}>
          Redirecting to login…
        </div>
      </div>
    );
  }

  return children;
}
