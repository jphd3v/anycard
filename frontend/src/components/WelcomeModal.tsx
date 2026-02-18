import { Overlay } from "./Overlay";

interface Props {
  onClose: () => void;
  onSignInClick: () => void;
}

export function WelcomeModal({ onClose, onSignInClick }: Props) {
  return (
    <Overlay
      translucent
      blurred
      className="items-center justify-center p-4 md:p-8"
    >
      <div
        className="relative w-full max-w-md bg-surface-1 rounded-2xl shadow-floating flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-surface-3"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 md:p-8 flex flex-col items-center text-center space-y-6">
          <div className="space-y-2">
            <h2 className="text-3xl font-serif-display font-black text-ink">
              Welcome to AnyCard
            </h2>
            <p className="text-sm font-medium text-ink-muted uppercase tracking-widest">
              Universal Card Game Engine
            </p>
          </div>

          <div className="space-y-4 text-ink-muted leading-relaxed text-sm">
            <p>
              AnyCard is a free, open-source platform for playing card games
              with friends or AI.
            </p>
            <p>
              <strong>Privacy First:</strong> We use a minimal cookie to keep
              your session active. You can play as a guest without creating an
              account.
            </p>
            <p>
              Optionally, you can sign in with your email to keep your identity
              across devices.
            </p>
          </div>

          <div className="w-full flex flex-col gap-3 pt-2">
            <button
              onClick={onClose}
              className="button-base button-primary w-full py-3 text-base"
            >
              Play as Guest
            </button>
            <button
              onClick={() => {
                onClose();
                onSignInClick();
              }}
              className="button-base button-ghost w-full py-2 text-sm text-ink-muted hover:text-ink hover:bg-surface-2"
            >
              Sign In / Recover Account
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
