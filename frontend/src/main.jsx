import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Mount the slot application into the single Vite root container.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
