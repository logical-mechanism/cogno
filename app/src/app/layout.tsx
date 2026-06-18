import type { Metadata, Viewport } from "next";
import "../styles/globals.css";
import "../styles/fonts";

export const metadata: Metadata = {
  title: "cogno-chain — reading room",
  description:
    "Post text, read text. A feeless, operator-run social chain whose posting capacity is earned by locking ADA on Cardano. Usable, not yet trustless — best vs finalized is shown honestly; Cardano identity and an in-browser wallet lock are live.",
  applicationName: "cogno-chain",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF8F3" },
    { media: "(prefers-color-scheme: dark)", color: "#14161A" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
