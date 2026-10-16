import { CallHandler, ExecutionContext, Injectable, NestInterceptor, ExceptionFilter, Catch, ArgumentsHost, Module, DynamicModule } from '@nestjs/common';
import { Observable } from 'rxjs';
import { VantaTrace } from './index';

/**
 * Interceptor that applies VantaTrace's request context to NestJS route handlers.
 */
@Injectable()
export class VantaTraceInterceptor implements NestInterceptor {
  constructor(private readonly vantaTrace: VantaTrace) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    return new Observable((subscriber) => {
      const middleware = this.vantaTrace.requestHandler();
      middleware(req, res, () => {
        const subscription = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
        return () => subscription.unsubscribe();
      });
    });
  }
}

/**
 * Global Exception Filter to automatically capture unhandled exceptions in NestJS.
 */
@Catch()
export class VantaTraceExceptionFilter implements ExceptionFilter {
  constructor(private readonly vantaTrace: VantaTrace) {}

  catch(exception: Error, host: ArgumentsHost) {
    this.vantaTrace.captureException(exception);
    
    // In a real app, you'd want to use HttpAdapterHost to send a proper error response,
    // but as a generic SDK filter, we re-throw to let the default NestJS exception handler take over.
    throw exception;
  }
}

/**
 * Dynamic module to easily integrate VantaTrace into a NestJS application.
 */
@Module({})
export class VantaTraceModule {
  static forRoot(instance: VantaTrace): DynamicModule {
    return {
      module: VantaTraceModule,
      providers: [
        {
          provide: 'VANTA_TRACE_INSTANCE',
          useValue: instance,
        },
        {
          provide: VantaTraceInterceptor,
          useFactory: (trace: VantaTrace) => new VantaTraceInterceptor(trace),
          inject: ['VANTA_TRACE_INSTANCE'],
        },
        {
          provide: VantaTraceExceptionFilter,
          useFactory: (trace: VantaTrace) => new VantaTraceExceptionFilter(trace),
          inject: ['VANTA_TRACE_INSTANCE'],
        }
      ],
      exports: ['VANTA_TRACE_INSTANCE', VantaTraceInterceptor, VantaTraceExceptionFilter],
    };
  }
}
