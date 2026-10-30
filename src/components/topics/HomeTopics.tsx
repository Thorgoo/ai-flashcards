import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Check, ChevronDown, Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import type { Topic, TopicOverview } from "@/lib/topics/repository";
import { TOPIC_NAME_MAX } from "@/lib/topics/schemas";
import { callApi } from "./api";
import { Confirmation } from "./Confirmation";
import { TOPIC_STATUS_LABELS, dueLabel, lastSessionLabel } from "./labels";

interface Props {
  topics: TopicOverview[];
}

type Change = { name: string } | { archived: boolean };

// Errors after which the page's list is out of date (archived or deleted elsewhere).
const STALE_CODES = ["topic_archived", "not_found"];

export default function HomeTopics({ topics: initial }: Props) {
  // One list, newest first; archiving only flips archivedAt, so both sections keep that order.
  const [topics, setTopics] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function setError(id: string, message: string | null) {
    setErrors((current) => {
      const { [id]: _removed, ...rest } = current;
      return message === null ? rest : { ...rest, [id]: message };
    });
  }

  // The row takes the server's name and archivedAt; the counts stay from the page's overview.
  async function save(id: string, change: Change): Promise<boolean> {
    setBusyId(id);
    setError(id, null);
    const result = await callApi<Topic>(`/api/topics/${id}`, "PATCH", change);
    setBusyId(null);
    if (result.ok) {
      const { name, archivedAt } = result.data;
      setTopics((current) => current.map((topic) => (topic.id === id ? { ...topic, name, archivedAt } : topic)));
      return true;
    }
    setError(id, result.error.message);
    if (STALE_CODES.includes(result.error.code)) window.location.reload();
    return false;
  }

  if (topics.length === 0) {
    return (
      <p className="text-muted-foreground border-border rounded-lg border p-6 text-center">
        Nie masz jeszcze tematów. Utwórz pierwszy — AI zaproponuje podtematy do nauki.
      </p>
    );
  }

  const active = topics.filter((topic) => topic.archivedAt === null);
  const archived = topics.filter((topic) => topic.archivedAt !== null);

  return (
    <div className="space-y-6">
      {active.length === 0 ? (
        <p className="text-muted-foreground border-border rounded-lg border p-6 text-center">
          Wszystkie tematy są zarchiwizowane.
        </p>
      ) : (
        <ul className="space-y-2" aria-busy={busyId !== null}>
          {active.map((topic) => (
            <ActiveRow
              key={topic.id}
              topic={topic}
              busy={busyId === topic.id}
              error={errors[topic.id] ?? null}
              onError={(message) => {
                setError(topic.id, message);
              }}
              onRename={(name) => save(topic.id, { name })}
              onArchive={() => void save(topic.id, { archived: true })}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <Collapsible className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="group w-full justify-start">
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
              Zarchiwizowane ({archived.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-2">
              {archived.map((topic) => (
                <li key={topic.id} className="border-border bg-card space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted-foreground min-w-0 flex-1 basis-40 truncate">{topic.name}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === topic.id}
                      onClick={() => void save(topic.id, { archived: false })}
                    >
                      <ArchiveRestore />
                      Przywróć
                    </Button>
                  </div>
                  <RowError message={errors[topic.id] ?? null} />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function ActiveRow(props: {
  topic: TopicOverview;
  busy: boolean;
  error: string | null;
  onError: (message: string | null) => void;
  onRename: (name: string) => Promise<boolean>;
  onArchive: () => void;
}) {
  const { topic } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(topic.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  function startEditing() {
    setName(topic.name);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    props.onError(null);
  }

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === "") {
      props.onError("Nazwa tematu nie może być pusta.");
      return;
    }
    if (trimmed === topic.name) {
      cancel();
      return;
    }
    if (await props.onRename(trimmed)) setEditing(false);
  }

  return (
    <li className="border-border bg-card text-card-foreground space-y-3 rounded-lg border p-4">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={input}
            aria-label="Nowa nazwa tematu"
            className="min-w-0 flex-1 basis-48"
            value={name}
            maxLength={TOPIC_NAME_MAX}
            disabled={props.busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") cancel();
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={props.busy} onClick={() => void submit()}>
              <Check />
              Zapisz
            </Button>
            <Button size="sm" variant="outline" disabled={props.busy} onClick={cancel}>
              <X />
              Anuluj
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <a
            href={`/topics/${topic.id}`}
            className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px]"
          >
            {topic.name}
          </a>
          <Badge variant={topic.status === "confirmed" ? "default" : "secondary"}>
            {TOPIC_STATUS_LABELS[topic.status]}
          </Badge>
        </div>
      )}

      {/* A draft has no flashcards yet, so it shows no study counts. */}
      {topic.status === "confirmed" && (
        <p className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>{dueLabel(topic.dueCount)}</span>
          <span>{lastSessionLabel(topic.lastStudiedOn)}</span>
        </p>
      )}

      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={props.busy} onClick={startEditing}>
            <Pencil />
            Zmień nazwę
          </Button>
          <Confirmation
            trigger={
              <Button size="sm" variant="outline" disabled={props.busy}>
                <Archive />
                Archiwizuj
              </Button>
            }
            title={`Zarchiwizować temat „${topic.name}”?`}
            description="Temat i jego fiszki znikną z listy. Nic nie zostanie usunięte — możesz go przywrócić w sekcji Zarchiwizowane."
            action="Archiwizuj"
            onConfirm={props.onArchive}
          />
        </div>
      )}

      <RowError message={props.error} />
    </li>
  );
}

function RowError(props: { message: string | null }) {
  if (props.message === null) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {props.message}
    </p>
  );
}
