import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

// The call can take tens of seconds; a ticking counter shows the app is still working.
export function GeneratingNotice({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div role="status" className="border-border bg-card flex items-center gap-3 rounded-lg border p-4">
      <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" />
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground text-sm">To może potrwać kilkanaście sekund ({seconds} s).</p>
      </div>
    </div>
  );
}
