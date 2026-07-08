import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MiniPlayer } from "./MiniPlayer";

// One bundle, two windows: the tray mini panel loads `index.html#mini`
// (src-tauri setup_mini_panel) and mounts the panel UI instead of the
// full app. Hash routing keeps Vite/dev-server config untouched.
const Root = window.location.hash === "#mini" ? MiniPlayer : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
