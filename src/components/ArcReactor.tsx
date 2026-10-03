export function ArcReactor({ active = false, size = 80 }: { active?: boolean; size?: number }) {
  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: "var(--gradient-glow)" }}
      />
      <div className="absolute inset-0 rounded-full border border-primary/40 animate-spin-slow" />
      <div className="absolute inset-2 rounded-full border border-accent/30 animate-spin-reverse" />
      <div
        className={`absolute inset-[30%] rounded-full bg-primary/80 glow-ring ${
          active ? "animate-pulse-ring" : ""
        }`}
      />
      <div className="absolute inset-[42%] rounded-full bg-accent" />
    </div>
  );
}
