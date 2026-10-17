"use client";
import dynamic from "next/dynamic";

// ui/src reads window/location when its modules load, so the app renders in the browser only.
const CloudApp = dynamic(() => import("./CloudApp.tsx").then((m) => m.CloudApp), {
  ssr: false,
  loading: () => (
    <div className="gate" aria-busy="true">
      <div className="skeleton" style={{ width: 240 }}>
        <span style={{ width: "80%" }} />
        <span style={{ width: "55%" }} />
      </div>
    </div>
  ),
});

export function AppLoader() {
  return <CloudApp />;
}
