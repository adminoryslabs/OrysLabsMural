import type { Metadata } from "next";
import themeInit from "@adminoryslabs/design-system/theme-init";
import "@adminoryslabs/design-system/fonts";
import "@adminoryslabs/design-system/css";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrysLabs Collab",
  description: "Collaborative whiteboard for software architecture classes",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-line="academy"
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        {/* Applies the stored theme before the first paint, so there is no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
