export function EmptyState({ children }: { readonly children: string }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
