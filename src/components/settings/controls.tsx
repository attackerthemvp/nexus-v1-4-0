import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/** Grouped HUD card with a titled header. */
export function Group({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel rounded-lg", className)}>
      <header className="border-b border-border/60 px-4 py-2">
        <h3 className="font-display text-[11px] tracking-[0.18em] text-primary">{title}</h3>
        {hint ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{hint}</p> : null}
      </header>
      <div className="divide-y divide-border/40">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  control,
  disabled,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-2.5",
        disabled && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <div className="font-mono text-xs text-foreground">{label}</div>
        {description ? (
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      label={label}
      {...(description ? { description } : {})}
      {...(disabled ? { disabled } : {})}
      control={<Switch checked={checked} onCheckedChange={onChange} disabled={!!disabled} />}
    />
  );
}

export function SelectRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      label={label}
      {...(description ? { description } : {})}
      {...(disabled ? { disabled } : {})}
      control={
        <select
          value={value}
          disabled={!!disabled}
          onChange={(e) => onChange(e.target.value as T)}
          className="max-w-[13rem] rounded border border-border bg-input/60 px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary focus:outline-none disabled:cursor-not-allowed"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

export function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("px-4 py-2.5", disabled && "opacity-50")}>
      <div className="flex items-center justify-between">
        <div className="font-mono text-xs text-foreground">{label}</div>
        <span className="font-mono text-[11px] text-primary">
          {value}
          {suffix ?? ""}
        </span>
      </div>
      {description ? (
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{description}</p>
      ) : null}
      <Slider
        className="mt-2"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={!!disabled}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}

export function TextRow({
  label,
  description,
  value,
  placeholder,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      label={label}
      {...(description ? { description } : {})}
      {...(disabled ? { disabled } : {})}
      control={
        <input
          value={value}
          placeholder={placeholder ?? ""}
          disabled={!!disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-40 rounded border border-border bg-input/60 px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary focus:outline-none"
        />
      }
    />
  );
}

export function StatusRow({
  label,
  value,
  ok,
  tone = "auto",
}: {
  label: string;
  value: string;
  ok?: boolean;
  tone?: "auto" | "neutral";
}) {
  const color =
    tone === "neutral"
      ? "text-muted-foreground"
      : ok === undefined
        ? "text-foreground"
        : ok
          ? "text-primary"
          : "text-destructive";
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2">
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("flex items-center gap-1.5 font-mono text-[11px]", color)}>
        {ok !== undefined && (
          <span
            className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-primary" : "bg-destructive")}
            aria-hidden
          />
        )}
        {value}
      </span>
    </div>
  );
}

export function ActionRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return <Row label={label} {...(description ? { description } : {})} control={children} />;
}

export function HudButton({
  children,
  onClick,
  variant = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded border px-3 py-1 font-display text-[11px] tracking-wider transition",
        variant === "danger"
          ? "border-destructive/60 text-destructive hover:bg-destructive/10"
          : "border-primary/50 text-primary hover:bg-primary/10",
      )}
    >
      {children}
    </button>
  );
}
