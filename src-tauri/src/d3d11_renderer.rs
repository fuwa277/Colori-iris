use windows::{
    core::*,
    Win32::Foundation::*,
    Win32::Graphics::Direct3D::*,
    Win32::Graphics::Direct3D11::*,
    Win32::Graphics::Dxgi::Common::*,
};
use egui::{epaint::{Mesh, Vertex, Primitive}, TextureId, ClippedPrimitive};
use std::mem::size_of;

// [优化] 顶点着色器保持不变
const VS_SRC: &[u8] = b"
cbuffer ConstBuffer : register(b0) { float4 screen_size; };
struct VS_INPUT { float2 pos : POSITION; float2 uv : TEXCOORD; float4 col : COLOR; };
struct PS_INPUT { float4 pos : SV_POSITION; float4 col : COLOR; float2 uv : TEXCOORD; };
PS_INPUT main(VS_INPUT input) {
    PS_INPUT output;
    output.pos = float4(
        2.0 * input.pos.x / screen_size.x - 1.0,
        1.0 - 2.0 * input.pos.y / screen_size.y,
        0.0, 1.0
    );
    output.col = input.col;
    output.uv = input.uv;
    return output;
}
\0";

// [优化] 像素着色器：增加对采样器 alpha 的保护
const PS_SRC: &[u8] = b"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
cbuffer PixelParams : register(b1) { float4 gray_weights; int use_gray; int render_type; float2 padding; };
struct PS_INPUT { float4 pos : SV_POSITION; float4 col : COLOR; float2 uv : TEXCOORD; };
float4 main(PS_INPUT input) : SV_Target {
    float4 t = tex.Sample(samp, input.uv);
    
    if (render_type == 1) {
        t.a = 1.0; 
    }

    float4 c = input.col * t;
    
    if (use_gray) {
        float g = dot(c.rgb, gray_weights.rgb);
        c.rgb = float3(g, g, g) * c.a; 
    }
    return c;
}
\0";

#[repr(C)]
struct ConstBuffer { screen_size: [f32; 4] }

#[repr(C)]
struct PixelParams { 
    gray_weights: [f32; 4], 
    use_gray: i32, 
    render_type: i32, 
    padding: [f32; 2] 
}

pub struct Renderer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    input_layout: ID3D11InputLayout,
    vertex_buffer: ID3D11Buffer,
    index_buffer: ID3D11Buffer,
    const_buffer: ID3D11Buffer,
    pixel_cb: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    blend_state: ID3D11BlendState,
    rasterizer_state: ID3D11RasterizerState,
    vertex_buffer_size: usize,
    index_buffer_size: usize,
    pub gray_weights: [f32; 3],
    pub use_gray: bool,
}

impl Renderer {
    pub fn new(device: ID3D11Device, context: ID3D11DeviceContext) -> Result<Self> {
        unsafe {
            // Shaders
            let vs_blob = compile_shader(VS_SRC, "main", "vs_5_0")?;
            let ps_blob = compile_shader(PS_SRC, "main", "ps_5_0")?;
            
            let mut vs = None;
            device.CreateVertexShader(std::slice::from_raw_parts(vs_blob.GetBufferPointer() as *const u8, vs_blob.GetBufferSize()), None, Some(&mut vs))?;
            
            let mut ps = None;
            device.CreatePixelShader(std::slice::from_raw_parts(ps_blob.GetBufferPointer() as *const u8, ps_blob.GetBufferSize()), None, Some(&mut ps))?;

            // Layout
            let desc = [
                D3D11_INPUT_ELEMENT_DESC { SemanticName: s!("POSITION"), Format: DXGI_FORMAT_R32G32_FLOAT, AlignedByteOffset: 0, InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA, ..Default::default() },
                D3D11_INPUT_ELEMENT_DESC { SemanticName: s!("TEXCOORD"), Format: DXGI_FORMAT_R32G32_FLOAT, AlignedByteOffset: 8, InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA, ..Default::default() },
                D3D11_INPUT_ELEMENT_DESC { SemanticName: s!("COLOR"), Format: DXGI_FORMAT_R8G8B8A8_UNORM, AlignedByteOffset: 16, InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA, ..Default::default() },
            ];
            
            let mut input_layout = None;
            device.CreateInputLayout(&desc, std::slice::from_raw_parts(vs_blob.GetBufferPointer() as *const u8, vs_blob.GetBufferSize()), Some(&mut input_layout))?;

            // Buffers
            let vb = create_buffer(&device, 1024 * 1024, D3D11_BIND_VERTEX_BUFFER)?;
            let ib = create_buffer(&device, 1024 * 1024, D3D11_BIND_INDEX_BUFFER)?;
            // [修复] 使用 DEFAULT 用法创建常量缓冲区，以便 UpdateSubresource 生效
            let cb = create_constant_buffer(&device, size_of::<ConstBuffer>())?;
            let pcb = create_constant_buffer(&device, size_of::<PixelParams>())?;

            // States
            let sampler = create_sampler(&device)?;
            let blend_state = create_blend(&device)?;
            let rasterizer = create_rasterizer(&device)?;

            Ok(Self {
                device, context, vs: vs.unwrap(), ps: ps.unwrap(), input_layout: input_layout.unwrap(),
                vertex_buffer: vb, index_buffer: ib, const_buffer: cb, pixel_cb: pcb,
                sampler, blend_state, rasterizer_state: rasterizer,
                vertex_buffer_size: 1024 * 1024, index_buffer_size: 1024 * 1024,
                gray_weights: [0.299, 0.587, 0.114], use_gray: false,
            })
        }
    }

    pub fn render(&mut self, width: f32, height: f32, primitives: &[ClippedPrimitive], textures: &std::collections::HashMap<TextureId, ID3D11ShaderResourceView>) {
        if width <= 0.0 || height <= 0.0 { return; }

        unsafe {
            let viewport = D3D11_VIEWPORT { Width: width, Height: height, MaxDepth: 1.0, ..Default::default() };
            self.context.RSSetViewports(Some(&[viewport]));
            self.context.OMSetDepthStencilState(None, 0);
            self.context.OMSetBlendState(&self.blend_state, Some(&[0.0; 4]), 0xFFFFFFFF);
            self.context.RSSetState(&self.rasterizer_state);
            self.context.IASetInputLayout(&self.input_layout);
            self.context.VSSetShader(&self.vs, None);
            self.context.PSSetShader(&self.ps, None);
            self.context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

            // Constants
            let cb_data = ConstBuffer { screen_size: [width, height, 0.0, 0.0] };
            self.context.UpdateSubresource(&self.const_buffer, 0, None, &cb_data as *const _ as *const _, 0, 0);
            self.context.VSSetConstantBuffers(0, Some(&[Some(self.const_buffer.clone())]));

            let mut pb_data = PixelParams { 
                gray_weights: [self.gray_weights[0], self.gray_weights[1], self.gray_weights[2], 0.0], 
                use_gray: if self.use_gray { 1 } else { 0 },
                render_type: 0, 
                padding: [0.0; 2] 
            };

            for prim in primitives {
                if let Primitive::Mesh(mesh) = &prim.primitive {
                    if mesh.vertices.is_empty() { continue; }
                    self.upload_mesh(mesh);

                    let mut srv_to_bind = None;
                    if let Some(view) = textures.get(&mesh.texture_id) {
                        srv_to_bind = Some(view.clone());
                    }
                    self.context.PSSetShaderResources(0, Some(&[srv_to_bind]));

                    let mut is_video = false;
                    if let egui::TextureId::User(id) = mesh.texture_id {
                        if id == 0 { is_video = true; }
                    }
                    pb_data.render_type = if is_video { 1 } else { 0 };
                    
                    self.context.UpdateSubresource(&self.pixel_cb, 0, None, &pb_data as *const _ as *const _, 0, 0);
                    self.context.PSSetConstantBuffers(1, Some(&[Some(self.pixel_cb.clone())]));

                    // Scissor
                    let clip = prim.clip_rect;
                    // 确保裁剪框在合理范围内
                    let left = (clip.min.x as i32).max(0);
                    let top = (clip.min.y as i32).max(0);
                    let right = (clip.max.x as i32).min(width as i32);
                    let bottom = (clip.max.y as i32).min(height as i32);

                    if right > left && bottom > top {
                        let scissor = RECT { left, top, right, bottom };
                        self.context.RSSetScissorRects(Some(&[scissor]));

                        let buffers = [Some(self.vertex_buffer.clone())];
                        let strides = [size_of::<Vertex>() as u32];
                        let offsets = [0];
                        self.context.IASetVertexBuffers(0, 1, Some(buffers.as_ptr()), Some(strides.as_ptr()), Some(offsets.as_ptr()));
                        self.context.IASetIndexBuffer(&self.index_buffer, DXGI_FORMAT_R32_UINT, 0);
                        self.context.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                        self.context.DrawIndexed(mesh.indices.len() as u32, 0, 0);
                    }
                }
            }
        }
    }

    unsafe fn upload_mesh(&self, mesh: &Mesh) {
        let mut map = D3D11_MAPPED_SUBRESOURCE::default();
        if self.context.Map(&self.vertex_buffer, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut map)).is_ok() {
            std::ptr::copy_nonoverlapping(mesh.vertices.as_ptr(), map.pData as *mut Vertex, mesh.vertices.len());
            self.context.Unmap(&self.vertex_buffer, 0);
        }
        if self.context.Map(&self.index_buffer, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut map)).is_ok() {
            std::ptr::copy_nonoverlapping(mesh.indices.as_ptr(), map.pData as *mut u32, mesh.indices.len());
            self.context.Unmap(&self.index_buffer, 0);
        }
    }

    pub fn create_texture(&self, width: u32, height: u32, pixels: &[u8]) -> Result<ID3D11ShaderResourceView> {
        unsafe {
            let stride = width * 4;
            let data = D3D11_SUBRESOURCE_DATA {
                pSysMem: pixels.as_ptr() as _,
                SysMemPitch: stride,
                SysMemSlicePitch: 0,
            };
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width, Height: height, MipLevels: 1, ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0, MiscFlags: 0,
            };
            let mut tex = None;
            self.device.CreateTexture2D(&desc, Some(&data), Some(&mut tex))?;
            let mut srv = None;
            self.device.CreateShaderResourceView(&tex.unwrap(), None, Some(&mut srv))?;
            Ok(srv.unwrap())
        }
    }
}

// Shader Compiler & Helpers
#[link(name = "d3dcompiler")]
extern "system" {
    fn D3DCompile(pSrcData: *const u8, SrcDataSize: usize, pSourceName: *const u8, pDefines: *const std::ffi::c_void, pInclude: *const std::ffi::c_void, pEntrypoint: *const u8, pTarget: *const u8, Flags1: u32, Flags2: u32, ppCode: *mut *mut std::ffi::c_void, ppErrorMsgs: *mut *mut std::ffi::c_void) -> windows::core::HRESULT;
}
fn compile_shader(src: &[u8], entry: &str, target: &str) -> Result<ID3DBlob> {
    unsafe {
        let mut blob: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut errors: *mut std::ffi::c_void = std::ptr::null_mut();
        let entry_c = std::ffi::CString::new(entry).unwrap();
        let target_c = std::ffi::CString::new(target).unwrap();
        let hr = D3DCompile(src.as_ptr(), src.len().saturating_sub(1), std::ptr::null(), std::ptr::null(), std::ptr::null(), entry_c.as_ptr() as _, target_c.as_ptr() as _, 0, 0, &mut blob, &mut errors);
        if hr.is_err() && !errors.is_null() {
            let err_blob: ID3DBlob = std::mem::transmute(errors);
            let msg = std::slice::from_raw_parts(err_blob.GetBufferPointer() as *const u8, err_blob.GetBufferSize());
            println!("Shader Error: {}", String::from_utf8_lossy(msg));
        }
        if hr.is_ok() { Ok(std::mem::transmute(blob)) } else { Err(Error::from(hr)) }
    }
}
unsafe fn create_buffer(device: &ID3D11Device, size: usize, bind_flags: D3D11_BIND_FLAG) -> Result<ID3D11Buffer> {
    let desc = D3D11_BUFFER_DESC { ByteWidth: size as u32, Usage: D3D11_USAGE_DYNAMIC, BindFlags: bind_flags.0 as u32, CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32, ..Default::default() };
    let mut buffer = None; device.CreateBuffer(&desc, None, Some(&mut buffer))?; Ok(buffer.unwrap())
}
unsafe fn create_sampler(device: &ID3D11Device) -> Result<ID3D11SamplerState> {
    // [优化] 使用各向异性过滤 (ANISOTROPIC) 以改善缩放时的画质
    let desc = D3D11_SAMPLER_DESC { 
        Filter: D3D11_FILTER_ANISOTROPIC, 
        MaxAnisotropy: 16,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP, 
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP, 
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP, 
        ..Default::default() 
    };
    let mut state = None; device.CreateSamplerState(&desc, Some(&mut state))?; Ok(state.unwrap())
}
unsafe fn create_blend(device: &ID3D11Device) -> Result<ID3D11BlendState> {
    // [重要修复] Egui 使用预乘 Alpha，必须使用 ONE + INV_SRC_ALPHA
    let mut desc = D3D11_BLEND_DESC::default();
    desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: true.into(),
        SrcBlend: D3D11_BLEND_ONE, // 修复：原为 SRC_ALPHA
        DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: D3D11_BLEND_ONE,
        DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOpAlpha: D3D11_BLEND_OP_ADD,
        RenderTargetWriteMask: 0x0F,
    };
    let mut state = None; device.CreateBlendState(&desc, Some(&mut state))?; Ok(state.unwrap())
}
unsafe fn create_rasterizer(device: &ID3D11Device) -> Result<ID3D11RasterizerState> {
    // 确保 ScissorEnable 为 false (根据上次修复)
    let desc = D3D11_RASTERIZER_DESC { FillMode: D3D11_FILL_SOLID, CullMode: D3D11_CULL_NONE, ScissorEnable: false.into(), DepthClipEnable: true.into(), ..Default::default() };
    let mut state = None; device.CreateRasterizerState(&desc, Some(&mut state))?; Ok(state.unwrap())
}

// [新增] 专用常量缓冲区创建函数 (DEFAULT usage)
unsafe fn create_constant_buffer(device: &ID3D11Device, size: usize) -> Result<ID3D11Buffer> {
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: size as u32,
        Usage: D3D11_USAGE_DEFAULT, // 关键：使用 DEFAULT 以支持 UpdateSubresource
        BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
        CPUAccessFlags: 0, // 关键：无 CPU 访问权限
        ..Default::default()
    };
    let mut buffer = None;
    device.CreateBuffer(&desc, None, Some(&mut buffer))?;
    Ok(buffer.unwrap())
}