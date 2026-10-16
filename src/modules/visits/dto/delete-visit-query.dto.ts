import { Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

export class DeleteVisitQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  expectedVersion!: number;
}
