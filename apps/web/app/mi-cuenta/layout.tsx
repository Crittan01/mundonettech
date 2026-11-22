import { Suspense, type ReactNode } from "react";

import { AccountNav } from "@/components/account/account-nav";

import AccountLoading from "./loading";

export default function CustomerAccountLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10 sm:px-8">
      <Suspense fallback={<AccountLoading />}>
        <AccountNav />
        {children}
      </Suspense>
    </div>
  );
}
