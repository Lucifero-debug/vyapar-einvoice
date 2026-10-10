import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import Backbutton from "@/components/Backbutton";
import ReloadButton from "@/components/ReloadButton";
import { SaleOptionProvider } from '@/context/SaleOptionContext';
import { CompanyProvider } from '@/context/CompanyContext';
import TodaysOrders from "@/components/TodaysOrders";
import UserMenu from "@/components/UserMenu";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Vyapaar — Billing & GST",
  description: "Invoicing, stock and ledgers for your business.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen antialiased`}
      >
        {/* The signed-in firm's letterhead, fetched once for every
            document in the app. See context/CompanyContext.js. */}
        <CompanyProvider>
        <SaleOptionProvider>
          <header className="no-print sticky top-0 z-50 border-b border-border bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70">
            <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-3 sm:px-6">
              <Backbutton />
              <ReloadButton />

              <Link
                href="/"
                className="ml-1 flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-secondary"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm">
                  ₹
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-semibold text-foreground">Vyapaar</span>
                  <span className="hidden text-[11px] text-muted-foreground sm:block">
                    Billing &amp; GST
                  </span>
                </span>
              </Link>

              <nav className="ml-auto flex items-center gap-1">
                <Link href="/ledger?customerId=0" className="btn btn-ghost btn-sm hidden sm:inline-flex">
                  Ledger
                </Link>
                <Link href="/voucher" className="btn btn-ghost btn-sm hidden sm:inline-flex">
                  Vouchers
                </Link>
                <Link href="/saleadd" className="btn btn-primary btn-sm">
                  New Sale
                </Link>
                {/* Renders nothing when signed out, so the sign-in page keeps
                    a bare header. */}
                <UserMenu />
              </nav>
            </div>
          </header>

          <main>{children}</main>

          {/* Once each morning: the bills raised against an order dated
              today, which nothing else in the app ever shows again. */}
          <TodaysOrders />
        </SaleOptionProvider>
        </CompanyProvider>
      </body>
    </html>
  );
}
