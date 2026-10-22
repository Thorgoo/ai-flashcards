import { useState, type SubmitEvent } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SCOPE_NOTE_MAX, TOPIC_NAME_MAX } from "@/lib/topics/schemas";
import { callApi, type ApiError } from "./api";

export default function NewTopicForm() {
  const [name, setName] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await callApi<{ id: string }>("/api/topics", "POST", { name, scopeNote });
    if (result.ok) {
      // The editor starts generating once and drops the parameter, so a reload never generates twice.
      window.location.assign(`/topics/${result.data.id}?generate=1`);
      return;
    }
    setError(result.error);
    setPending(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="topic-name">Temat</Label>
        <Input
          id="topic-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={TOPIC_NAME_MAX}
          placeholder="np. Kubernetes, angielski"
          required
          aria-invalid={error?.code === "validation_failed"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="topic-scope">Zakres i poziom (opcjonalnie)</Label>
        <Textarea
          id="topic-scope"
          value={scopeNote}
          onChange={(event) => {
            setScopeNote(event.target.value);
          }}
          maxLength={SCOPE_NOTE_MAX}
          placeholder="np. Spring Boot 3, REST, używam na co dzień"
          rows={3}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending || name.trim() === ""}>
        {pending && <Loader2 className="animate-spin" />}
        Utwórz i wygeneruj podtematy
      </Button>
    </form>
  );
}
