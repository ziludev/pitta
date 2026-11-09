import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { tr } from "@/i18n";
import { useStore } from "@/store";

const ORDER = ["system", "light", "dark"] as const;

/** Cycles system → light → dark, persisted by next-themes. */
export function ThemeToggle() {
  const { lang } = useStore();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return <Button variant="ghost" size="icon-xs" disabled />;

  const current = (theme ?? "system") as (typeof ORDER)[number];
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!;
  const Icon = current === "system" ? Monitor : resolvedTheme === "dark" ? Moon : Sun;

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={`${tr(lang, "theme")}: ${current}`}
      onClick={() => setTheme(next)}
    >
      <Icon className="size-3" />
    </Button>
  );
}
