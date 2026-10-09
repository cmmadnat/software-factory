// Which cards have a Ship or Merge running right now, so a second press is refused instead of racing the
// first. In memory only: a server restart ends every operation, and Ship/Merge leave nothing half-done.
export type InFlightKind = "ship" | "merge" | "resolve";

export class InFlight {
  private running = new Map<number, InFlightKind>();

  begin(itemId: number, kind: InFlightKind): void {
    const current = this.running.get(itemId);
    if (current) throw new AlreadyRunning(current === "ship" ? "already shipping" : current === "merge" ? "already merging" : "already resolving the checkout");
    this.running.set(itemId, kind);
  }

  end(itemId: number): void {
    this.running.delete(itemId);
  }

  kindOf(itemId: number): InFlightKind | null {
    return this.running.get(itemId) ?? null;
  }
}

export class AlreadyRunning extends Error {}
