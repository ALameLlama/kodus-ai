import { IsObject, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class EditedByDto {
    @IsString()
    @ApiProperty({ example: 'user_123' })
    userId: string;

    @IsString()
    @ApiProperty({ format: 'email', example: 'admin@kodus.io' })
    email: string;
}

export class UserStatusDto {
    @IsString()
    @ApiProperty({ example: 'git_987654' })
    public gitId: string;

    @IsString()
    @ApiProperty({ example: 'github' })
    public gitTool: string;

    @IsString()
    @ApiProperty({ example: 'active' })
    public licenseStatus: 'active' | 'inactive';

    @IsString()
    @ApiProperty({ example: 'c33ef663-70e7-4f43-9605-0bbef979b8e0' })
    public teamId: string;

    @IsString()
    @ApiProperty({ example: '585e32e5-242e-4381-bef4-d2dfc61375f9' })
    public organizationId: string;

    @IsObject()
    @ApiProperty({
        type: EditedByDto,
        example: { userId: 'user_123', email: 'admin@kodus.io' },
    })
    public editedBy: EditedByDto;

    @IsString()
    @ApiProperty({ example: 'Jane Doe' })
    public userName: string;
}
