import type { ReactNode } from "react";

import { storeConfig } from "@mundonettech/config/store";
import Link from "next/link";

export function AuthShell({
  title,
  description,
  children,
  footer,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 text-center text-xl font-bold tracking-tight">
        {storeConfig.name}
      </Link>
      <section className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <div className="mb-6 space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {children}
      </section>
      {footer ? (
        <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
      ) : null}
    </main>
  );
}
