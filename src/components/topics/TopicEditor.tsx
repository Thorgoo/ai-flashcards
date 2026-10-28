import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { ClipboardList, GraduationCap, Layers, Lock, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Subtopic, TopicWithSubtopics } from "@/lib/topics/repository";
import { CONTENT_TYPES, SUBTOPIC_NAME_MAX, SUBTOPICS_MAX, SUBTOPICS_MIN, type ContentType } from "@/lib/topics/schemas";
import { callApi, type ApiError } from "./api";
import { Confirmation, PORTAL_THEME } from "./Confirmation";
import { GeneratingNotice } from "./GeneratingNotice";
import { CONTENT_TYPE_LABELS, TOPIC_STATUS_LABELS, studyLabel } from "./labels";

// Progress of the topic's quiz, for the entry button on a confirmed topic (null: no quiz yet).
export interface QuizSummary {
  generating: boolean;
  answered: number;
  total: number;
  completed: boolean;
}

interface Props {
  initial: TopicWithSubtopics;
  autoGenerate: boolean;
  quiz: QuizSummary | null;
  // Whether the topic already has its first flashcard batch (ready or generating).
  hasFlashcards: boolean;
  // The study entry once the batch is ready (null hides it); dueCount is null when counting failed.
  study: { dueCount: number | null } | null;
}

type Busy = "generate" | "save" | null;

export default function TopicEditor({ initial, autoGenerate, quiz, hasFlashcards, study }: Props) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const started = useRef(false);

  const { topic, subtopics } = state;
  const draft = topic.status === "draft";

  // State always comes from the server's answer; a failure keeps the current list.
  async function run(kind: Exclude<Busy, null>, path: string, method: string, body?: unknown) {
    setBusy(kind);
    setError(null);
    const result = await callApi<TopicWithSubtopics>(path, method, body);
    setBusy(null);
    if (result.ok) {
      setState(result.data);
      if (result.remaining !== undefined) setRemaining(result.remaining);
      return true;
    }
    setError({ error: result.error, retry: () => void run(kind, path, method, body) });
    return false;
  }

  const base = `/api/topics/${topic.id}`;
  const generate = () => void run("generate", `${base}/generate`, "POST");

  useEffect(() => {
    if (!autoGenerate || started.current) return;
    started.current = true;
    // Drop ?generate=1 first, so reloading the page while AI works never starts a second call.
    window.history.replaceState(null, "", window.location.pathname);
    generate();
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="min-w-0 text-2xl font-semibold break-words">{topic.name}</h1>
        <Badge variant={draft ? "secondary" : "default"}>{TOPIC_STATUS_LABELS[topic.status]}</Badge>
      </div>
      {topic.scopeNote && <p className="text-muted-foreground text-sm">{topic.scopeNote}</p>}

      {busy === "generate" ? (
        <GeneratingNotice label="AI przygotowuje podtematy…" />
      ) : (
        error && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{error.error.message}</span>
              {error.error.retryable && (
                <Button size="sm" variant="outline" onClick={error.retry}>
                  Spróbuj ponownie
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )
      )}

      {!draft ? (
        <ConfirmedList
          subtopics={subtopics}
          topicId={topic.id}
          quiz={quiz}
          hasFlashcards={hasFlashcards}
          study={study}
        />
      ) : subtopics.length === 0 ? (
        busy !== "generate" && (
          <div className="border-border space-y-3 rounded-lg border p-6 text-center">
            <p className="text-muted-foreground">Ten temat nie ma jeszcze podtematów.</p>
            <Button onClick={generate}>
              <Sparkles />
              Generuj podtematy
            </Button>
          </div>
        )
      ) : (
        <>
          <ul className="space-y-2" aria-busy={busy !== null}>
            {subtopics.map((subtopic) => (
              <SubtopicRow
                key={`${subtopic.id}:${subtopic.name}`}
                subtopic={subtopic}
                disabled={busy !== null}
                canDelete={subtopics.length > SUBTOPICS_MIN}
                onRename={(name) => run("save", `${base}/subtopics/${subtopic.id}`, "PATCH", { name })}
                onType={(contentType) => void run("save", `${base}/subtopics/${subtopic.id}`, "PATCH", { contentType })}
                onDelete={() => void run("save", `${base}/subtopics/${subtopic.id}`, "DELETE")}
              />
            ))}
          </ul>

          <AddSubtopic
            disabled={busy !== null || subtopics.length >= SUBTOPICS_MAX}
            onAdd={(name, contentType) => run("save", `${base}/subtopics`, "POST", { name, contentType })}
          />
          <p className="text-muted-foreground text-xs">
            Podtematy: {subtopics.length} (od {SUBTOPICS_MIN} do {SUBTOPICS_MAX})
            {remaining !== null && ` · Pozostałe generowania AI dzisiaj: ${remaining}`}
          </p>

          <div className="flex flex-wrap gap-2">
            <Confirmation
              trigger={
                <Button variant="outline" disabled={busy !== null}>
                  <RefreshCw />
                  Wygeneruj ponownie
                </Button>
              }
              title="Wygenerować listę od nowa?"
              description="Obecna lista, w tym Twoje poprawki, zostanie zastąpiona nową propozycją AI."
              action="Wygeneruj"
              onConfirm={generate}
            />
            <Confirmation
              trigger={
                <Button
                  disabled={busy !== null || subtopics.length < SUBTOPICS_MIN || subtopics.length > SUBTOPICS_MAX}
                >
                  <Lock />
                  Zatwierdź listę
                </Button>
              }
              title="Zatwierdzić listę podtematów?"
              description="Po zatwierdzeniu nie można zmieniać, dodawać ani usuwać podtematów. Na ich podstawie powstanie quiz diagnostyczny."
              action="Zatwierdź"
              onConfirm={() => void run("save", `${base}/confirm`, "POST")}
            />
          </div>
        </>
      )}
    </div>
  );
}

function SubtopicRow(props: {
  subtopic: Subtopic;
  disabled: boolean;
  canDelete: boolean;
  onRename: (name: string) => Promise<boolean>;
  onType: (contentType: ContentType) => void;
  onDelete: () => void;
}) {
  const { subtopic } = props;
  const [name, setName] = useState(subtopic.name);

  function commit() {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === subtopic.name) {
      setName(subtopic.name);
      return;
    }
    // A refused name (e.g. a duplicate) goes back to the saved one, so a later blur does not resend it.
    void props.onRename(trimmed).then((saved) => {
      if (!saved) setName(subtopic.name);
    });
  }

  return (
    <li className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <Input
        aria-label="Nazwa podtematu"
        className="min-w-0 flex-1 basis-48"
        value={name}
        maxLength={SUBTOPIC_NAME_MAX}
        disabled={props.disabled}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setName(subtopic.name);
        }}
      />
      <ContentTypeSelect value={subtopic.contentType} disabled={props.disabled} onChange={props.onType} />
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Usuń podtemat ${subtopic.name}`}
        title={props.canDelete ? "Usuń" : `Temat musi mieć co najmniej ${SUBTOPICS_MIN} podtematy`}
        disabled={props.disabled || !props.canDelete}
        onClick={props.onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function AddSubtopic(props: { disabled: boolean; onAdd: (name: string, type: ContentType) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [contentType, setContentType] = useState<ContentType>("conceptual");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    if (await props.onAdd(name.trim(), contentType)) setName("");
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Nowy podtemat"
        className="min-w-0 flex-1 basis-48"
        placeholder="Dodaj własny podtemat"
        value={name}
        maxLength={SUBTOPIC_NAME_MAX}
        disabled={props.disabled}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <ContentTypeSelect value={contentType} disabled={props.disabled} onChange={setContentType} />
      <Button type="submit" variant="secondary" disabled={props.disabled || name.trim() === ""}>
        <Plus />
        Dodaj
      </Button>
    </form>
  );
}

function ContentTypeSelect(props: { value: ContentType; disabled: boolean; onChange: (value: ContentType) => void }) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== props.value) props.onChange(value as ContentType);
      }}
    >
      <SelectTrigger aria-label="Typ treści" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={PORTAL_THEME}>
        {CONTENT_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            {CONTENT_TYPE_LABELS[type]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ConfirmedList(props: {
  subtopics: Subtopic[];
  topicId: string;
  quiz: QuizSummary | null;
  hasFlashcards: boolean;
  study: Props["study"];
}) {
  const { subtopics, quiz, study } = props;
  const quizPath = `/topics/${props.topicId}/quiz`;
  const flashcardsPath = `/topics/${props.topicId}/flashcards`;
  return (
    <>
      <ul className="space-y-2">
        {subtopics.map((subtopic) => (
          <li
            key={subtopic.id}
            className="border-border bg-card flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <span className="min-w-0 break-words">{subtopic.name}</span>
            <Badge variant="outline">{CONTENT_TYPE_LABELS[subtopic.contentType]}</Badge>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">Lista jest zatwierdzona i nie można jej już zmienić.</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant={quiz?.completed ? "outline" : "default"}>
          <a href={quiz ? quizPath : `${quizPath}?start=1`}>
            <ClipboardList />
            {quiz === null
              ? "Rozpocznij quiz diagnostyczny"
              : quiz.generating
                ? "Quiz w przygotowaniu…"
                : quiz.completed
                  ? "Zobacz wynik quizu"
                  : `Kontynuuj quiz (${quiz.answered}/${quiz.total})`}
          </a>
        </Button>
        {study && (
          <Button asChild>
            <a href={`/topics/${props.topicId}/study`}>
              <GraduationCap />
              {studyLabel(study.dueCount)}
            </a>
          </Button>
        )}
        {quiz?.completed && (
          <Button asChild variant={study ? "outline" : "default"}>
            <a href={props.hasFlashcards ? flashcardsPath : `${flashcardsPath}?start=1`}>
              <Layers />
              {props.hasFlashcards ? "Zobacz fiszki" : "Wygeneruj fiszki"}
            </a>
          </Button>
        )}
      </div>
    </>
  );
}
