import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./shell";
import zibzibLogo from "../zibzib.png";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Favicon />
      <StartupGate>
      <Routes>
        <Route path="/" element={<Navigate to="/giris" replace />} />
        <Route path="/giris" element={<App page="login" />} />
        <Route path="/kayit" element={<App page="register" />} />
        <Route path="/kurulum" element={<App page="profile" />} />
        <Route path="/mesajlar" element={<App page="inbox" />} />
        <Route path="/sohbet/:id" element={<App page="chat" />} />
        <Route path="/ayarlar/:tab?" element={<App page="settings" />} />
        <Route path="/yonetim" element={<App page="admin" />} />
        <Route path="*" element={<Navigate to="/giris" replace />} />
      </Routes>
      </StartupGate>
    </BrowserRouter>
  </React.StrictMode>
);

function Favicon() {
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.append(link);
    }
    link.type = "image/png";
    link.href = zibzibLogo;
  }, []);
  return null;
}

function StartupGate({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(() => !sessionStorage.getItem("zibzib-visited"));
  useEffect(() => {
    if (!visible) return;
    sessionStorage.setItem("zibzib-visited", "true");
    const timer = window.setTimeout(() => setVisible(false), 1200);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!visible) return children;
  return <main className="launch-screen"><img className="launch-logo" src={zibzibLogo} alt="ZibZib" /><strong>ZibZib</strong><small>Mesajların sana ait.</small><span className="launch-progress" /></main>;
}
