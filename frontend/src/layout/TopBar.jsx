import { useNavigate } from "react-router-dom";
import PricesBar from "./PricesBar";

export default function TopBar() {
  const navigate = useNavigate();
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <img
          src={logoSrc}
          alt="Finvault"
          className="finvault-logo"
          onClick={() => navigate("/spending/receipts-ledger")}
        />
      </div>

      <div className="topbar-center">
        <PricesBar />
      </div>

      <div className="topbar-right">
        <span>
          Welcome <strong>Sanjay</strong>
        </span>
        <button className="link-btn">Logout</button>
      </div>
    </header>
  );
}
