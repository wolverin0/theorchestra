/**
 * U1 placeholder — Spawn tab. U5 fills this with:
 *   - persona picker (search across 65 personas from /api/personas)
 *   - permission-mode radio
 *   - git-worktree toggle
 *   - cwd picker
 *   - Submit → POST /api/sessions with persona + permissionMode
 */

export function SpawnTab() {
  return (
    <div className="tab-placeholder">
      <div className="tab-placeholder-title">Spawn</div>
      <div className="tab-placeholder-body">
        Persona picker + permission-mode + worktree toggle — shipping in U5.
      </div>
    </div>
  );
}
