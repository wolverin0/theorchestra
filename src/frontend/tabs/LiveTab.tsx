/**
 * U1 placeholder — Live tab. U3 will fold the right activity sidebar and a
 * live event feed into this tab. For now, show a neutral placeholder so the
 * tab is reachable.
 */

export function LiveTab() {
  return (
    <div className="tab-placeholder">
      <div className="tab-placeholder-title">Live</div>
      <div className="tab-placeholder-body">
        Live activity feed + orchestrator status — shipping in U3.
      </div>
    </div>
  );
}
