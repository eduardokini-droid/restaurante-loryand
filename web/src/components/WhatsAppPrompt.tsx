import { Modal } from './ui';

export interface MessageResult { status: 'sent' | 'failed' | 'manual'; link?: string; error?: string }

/**
 * Tras confirmar una reserva o avisar a un grupo: en modo enlace (o si el envío automático falla)
 * ofrece abrir WhatsApp con el mensaje ya escrito. Un enlace no envía nada por sí solo.
 */
export function WhatsAppPrompt({ result, onClose }: { result: MessageResult | null; onClose: () => void }) {
  if (!result || result.status === 'sent' || !result.link) return null;
  return (
    <Modal title="Avisar por WhatsApp" onClose={onClose}>
      {result.status === 'failed' && <p className="notice small">El envío automático ha fallado: {result.error}. Puedes avisar a mano.</p>}
      <p className="small">Se abrirá WhatsApp con el mensaje escrito. Comprueba el número y pulsa enviar.</p>
      <a className="btn primary block" href={result.link} target="_blank" rel="noreferrer" onClick={onClose}>Abrir WhatsApp</a>
    </Modal>
  );
}
