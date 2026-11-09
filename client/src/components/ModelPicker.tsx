import { useEffect } from "react";
import { Cpu } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tr } from "@/i18n";
import { useStore } from "@/store";

const THINKING = ["off", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Per-conversation model and thinking level. Switching is a `configure()` on that
 * conversation only, so a cheap model in a busy group never changes the rest.
 */
export function ModelPicker() {
  const { lang, model, thinkingLevel, models, loadModels, setModel } = useStore();

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  if (model === undefined) return null;
  const providers = [...new Set(models.map((entry) => entry.provider))];
  const options = models.filter((entry) => entry.provider === model.provider);

  return (
    <div className="flex items-center gap-1">
      <Cpu className="size-3 text-muted-foreground" />
      <Select
        value={model.modelId}
        onValueChange={(modelId) => void setModel({ provider: model.provider, modelId, thinkingLevel })}
      >
        <SelectTrigger size="sm" className="h-6 max-w-[240px] gap-1 border-none bg-transparent px-1 text-[11px]">
          <SelectValue placeholder={tr(lang, "model")} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {options.map((entry) => (
            <SelectItem key={entry.id} value={entry.id} className="text-[11px]">
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={model.provider}
        onValueChange={(provider) => {
          const first = models.find((entry) => entry.provider === provider);
          if (first !== undefined) void setModel({ provider, modelId: first.id, thinkingLevel });
        }}
      >
        <SelectTrigger size="sm" className="h-6 max-w-[130px] gap-1 border-none bg-transparent px-1 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => (
            <SelectItem key={provider} value={provider} className="text-[11px]">
              {provider}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={thinkingLevel ?? "high"}
        onValueChange={(level) => void setModel({ provider: model.provider, modelId: model.modelId, thinkingLevel: level })}
      >
        <SelectTrigger size="sm" className="h-6 w-[86px] gap-1 border-none bg-transparent px-1 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THINKING.map((level) => (
            <SelectItem key={level} value={level} className="text-[11px]">
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
