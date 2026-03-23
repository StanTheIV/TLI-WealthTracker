import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

export class ErrorHandler implements EventHandler {
  readonly name    = 'error';
  readonly handles = ['reader_error'] as const;

  handle(event: RawEvent, _ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'reader_error') return;
    emit({type: 'error', message: event.message});
  }
}
