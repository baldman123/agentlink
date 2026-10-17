import type { Metadata, Viewport } from "next";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "../../ui/src/styles.css";
import "./cloud.css";

export const metadata: Metadata = {
  title: "agentlink",
  description: "Your claude4 team, and your friends' teams, in one place.",
  robots: { index: false, follow: false },
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='4' cy='8' r='3' fill='%23A7C7E7'/><circle cx='12' cy='8' r='3' fill='none' stroke='%23A7C7E7' stroke-width='2'/></svg>",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#08090c",
};

// The saved theme is applied before paint so a light-theme user doesn't see a dark flash.
const THEME_SCRIPT = `try{var t=JSON.parse(localStorage.getItem("al.theme"));if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
