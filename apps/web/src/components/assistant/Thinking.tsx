/** Three soft dots while the assistant works. Static under reduced motion. */
export function Thinking() {
  return (
    <div className="flex items-center gap-1.5 py-1 text-muted" role="status" aria-label="Ask Inbox is thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </div>
  );
}
