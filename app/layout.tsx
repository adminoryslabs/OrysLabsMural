import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrysLabs Collab",
  description: "Collaborative whiteboard for software architecture classes",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
