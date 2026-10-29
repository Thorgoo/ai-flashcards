import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, GraduationCap, Layers, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type {
  FlashcardBatchView,
  FlashcardState,
  FlashcardSummary,
  FlashcardView,
} from "@/lib/topics/flashcard-repository";
import { callApi, type ApiError } from "./api";
import { Confirmation } from "./Confirmation";
import { GeneratingNotice } from "./GeneratingNotice";
import { CONTENT_TYPE_LABELS, studyLabel } from "./labels";

interface Props {
  topicId: string;
  topicName: string;
  initial: FlashcardState | null;
  autoStart: boolean;
  // Due cards counted by the page; null when counting failed or the batch was generated here.
  dueCount: number | null;
}

type Busy = "generate" | "next" | "delete" | null;

const LETTERS = ["A", "B", "C", "D"];
const POLL_MS = 2000;
// Errors after which the page's batches are out of date.
const STALE_CODES = ["batch_generating", "batch_exists", "next_batch_locked", "topic_mastered"];

export default function FlashcardBatch({ topicId, topicName, initial, autoStart, dueCount }: Props) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ error: ApiError; retry: () => void } | null>(null);
  const started = useRef(false);
  const base = `/api/topics/${topicId}/flashcards`;

  // State always comes from the server's answer; a failure keeps the current cards.
  async function run(kind: Exclude<Busy, null>, path: string, method: string, body?: unknown) {
    setBusy(kind);
    setError(null);
    const result = await callApi<FlashcardState | null>(path, method, body);
    setBusy(null);
    if (result.ok) {
      setState(result.data);
      return;
    }
    // Another tab (or the request before a reload) changed the batches: show the current state.
    const { code } = result.error;
    if (STALE_CODES.includes(code)) await refresh();
    // A batch generating or finished elsewhere needs no message; a lock or a mastered topic does.
    if (code === "batch_generating" || code === "batch_exists") return;
    setError({ error: result.error, retry: () => void run(kind, path, method, body) });
  }

  async function refresh() {
    const result = await callApi<FlashcardState | null>(base, "GET");
    if (result.ok) setState(result.data);
  }

  // Polls the small summary; the cards are read once the generation has ended.
  async function poll() {
    const result = await callApi<FlashcardSummary | null>(`${base}/summary`, "GET");
    if (result.ok && !result.data?.generating) await refresh();
  }

  const generate = () => void run("generate", base, "POST");
  const generateNext = (seq: number) => void run("next", `${base}/next`, "POST", { seq });
  const remove = (cardId: string) => void run("delete", `${base}/${cardId}`, "DELETE");

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    // Drop ?start=1 first, so reloading the page while AI works never starts a second call.
    window.history.replaceState(null, "", window.location.pathname);
    generate();
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const batches = state?.batches ?? [];
  const ready = batches.length > 0;
  // Batch 1 hides the page until it is ready; a later batch keeps the ready ones visible.
  const generatingFirst = busy === "generate" || (Boolean(state?.generating) && !ready);
  const generatingNext = busy === "next" || (Boolean(state?.generating) && ready);
  // A request error of this page, else a failed generation stored on the batch (also one
  // that ended after a reload or in another tab); a new claim clears the stored one.
  const failed = state?.failed;
  const shownError =
    error ??
    (failed
      ? {
          error: failed.error,
          retry: () => {
            if (failed.seq === 1) generate();
            else generateNext(failed.seq);
          },
        }
      : null);

  // A generation started before a reload, or in another tab, finishes on the server; poll
  // until the batch is ready or failed (or its claim expires and reads as no batch).
  useEffect(() => {
    if (!state?.generating || busy !== null) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
    // poll only reads base, which is fixed for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, busy]);

  return (
    <div className="space-y-4">
      <a
        href={`/topics/${topicId}`}
        className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="min-w-0 break-words">{topicName}</span>
      </a>
      <h1 className="text-2xl font-semibold">Fiszki</h1>

      {generatingFirst ? (
        <GeneratingNotice label="AI przygotowuje fiszki…" />
      ) : generatingNext ? (
        <GeneratingNotice label="AI przygotowuje kolejną partię…" />
      ) : (
        shownError && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{shownError.error.message}</span>
              {shownError.error.retryable && (
                <Button size="sm" variant="outline" onClick={shownError.retry}>
                  Spróbuj ponownie
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )
      )}

      {generatingFirst ? null : state === null || !ready ? (
        <div className="border-border space-y-3 rounded-lg border p-6">
          <p>
            Partia ma 10 fiszek z podtematów tego tematu. Więcej fiszek dostaną podtematy, które w quizie poszły Ci
            najsłabiej, ale każdy podtemat dostanie co najmniej jedną.
          </p>
          <Button onClick={generate}>
            <Layers />
            Wygeneruj fiszki
          </Button>
        </div>
      ) : (
        <>
          <NextBatchPanel
            state={state}
            generating={generatingNext}
            disabled={busy !== null}
            onGenerate={generateNext}
          />
          <div aria-busy={busy !== null} className="space-y-6">
            {batches.map((batch, index) =>
              index === 0 ? (
                <section key={batch.id} className="space-y-4">
                  <h2 className="text-lg font-semibold">{batchTitle(batch)}</h2>
                  <BatchCards cards={batch.cards} disabled={busy !== null || generatingNext} onDelete={remove} />
                </section>
              ) : (
                <Collapsible key={batch.id} className="space-y-4">
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" className="group h-auto w-full justify-start whitespace-normal">
                      <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
                      <span className="min-w-0 text-left break-words">{batchTitle(batch)}</span>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <BatchCards cards={batch.cards} disabled={busy !== null || generatingNext} onDelete={remove} />
                  </CollapsibleContent>
                </Collapsible>
              ),
            )}
          </div>
        </>
      )}

      {!generatingFirst && ready && (
        <Button asChild>
          <a href={`/topics/${topicId}/study`}>
            <GraduationCap />
            {studyLabel(dueCount)}
          </a>
        </Button>
      )}
    </div>
  );
}

function batchTitle(batch: FlashcardBatchView): string {
  const mastered = batch.cards.filter((card) => card.mastered).length;
  return `Partia ${batch.seq} (opanowane ${mastered}/${batch.cards.length})`;
}

// Progress of the newest batch and the entry to the next one (S-07).
function NextBatchPanel(props: {
  state: FlashcardState;
  generating: boolean;
  disabled: boolean;
  onGenerate: (seq: number) => void;
}) {
  const { current, topicMastered } = props.state;
  if (!current) return null;
  const missing = Math.max(current.required - current.mastered, 0);
  // Why the button is off; null when it can start the next batch.
  const reason = props.generating
    ? "Kolejna partia jest w przygotowaniu."
    : topicMastered
      ? "Wszystkie podtematy są opanowane, więc kolejna partia nie jest potrzebna."
      : !current.unlocked
        ? `Opanuj jeszcze ${missing} z fiszek partii ${current.seq}, aby odblokować kolejną partię.`
        : null;
  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4">
      <p className="font-medium break-words">
        {topicMastered
          ? "Temat opanowany — wszystkie podtematy opanowane"
          : `Opanowane w partii ${current.seq}: ${current.mastered}/${current.total} — kolejna partia od ${current.required}`}
      </p>
      <Button
        disabled={props.disabled || reason !== null}
        aria-describedby={reason ? "next-batch-reason" : undefined}
        onClick={() => {
          props.onGenerate(current.seq + 1);
        }}
      >
        <Layers />
        Wygeneruj kolejną partię
      </Button>
      {reason && (
        <p id="next-batch-reason" className="text-muted-foreground text-sm">
          {reason}
        </p>
      )}
    </div>
  );
}

function BatchCards(props: { cards: FlashcardView[]; disabled: boolean; onDelete: (cardId: string) => void }) {
  if (props.cards.length === 0) {
    return (
      <p className="border-border text-muted-foreground rounded-lg border p-6 text-center">
        Ta partia nie ma już fiszek.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {groupBySubtopic(props.cards).map((group) => (
        <section key={group[0].subtopicId} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="min-w-0 text-lg font-semibold break-words">{group[0].subtopicName}</h3>
            <Badge variant="outline">{CONTENT_TYPE_LABELS[group[0].contentType]}</Badge>
          </div>
          <ul className="space-y-3">
            {group.map((card) => (
              <FlashcardItem
                key={card.id}
                card={card}
                disabled={props.disabled}
                onDelete={() => {
                  props.onDelete(card.id);
                }}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// Cards arrive sorted by subtopic (getFlashcardState), so consecutive runs are the groups.
function groupBySubtopic(cards: FlashcardView[]): FlashcardView[][] {
  const groups: FlashcardView[][] = [];
  for (const card of cards) {
    const last = groups.at(-1);
    if (last?.[0].subtopicId === card.subtopicId) last.push(card);
    else groups.push([card]);
  }
  return groups;
}

function FlashcardItem(props: { card: FlashcardView; disabled: boolean; onDelete: () => void }) {
  const { card } = props;
  return (
    <li className="border-border bg-card space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium break-words">{card.front}</p>
        {card.mastered && <Badge variant="secondary">Opanowana</Badge>}
      </div>
      <ul className="space-y-1 text-sm">
        {card.options.map((option, i) => {
          const correct = i === card.correctIndex;
          return (
            <li key={i} className={correct ? "text-primary font-semibold" : "text-muted-foreground"}>
              <span className="inline-flex items-start gap-1">
                {correct ? <Check className="mt-0.5 size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
                <span className="min-w-0 break-words">
                  {LETTERS[i]}. {option}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground text-xs">Wzorcowa odpowiedź</p>
        <p className="break-words whitespace-pre-line">{card.answer}</p>
      </div>
      {card.contentType === "vocabulary" && card.example && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground text-xs">Przykładowe zdanie</p>
          <p className="break-words italic">{card.example}</p>
        </div>
      )}
      <Collapsible className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group">
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
              Czytaj więcej
            </Button>
          </CollapsibleTrigger>
          <Confirmation
            trigger={
              <Button variant="ghost" size="sm" disabled={props.disabled}>
                <Trash2 />
                Usuń
              </Button>
            }
            title="Usunąć fiszkę?"
            description="Fiszka zostanie usunięta na stałe i nie da się jej przywrócić."
            action="Usuń"
            onConfirm={props.onDelete}
          />
        </div>
        <CollapsibleContent>
          <p className="text-muted-foreground text-sm break-words whitespace-pre-line">{card.explanation}</p>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
